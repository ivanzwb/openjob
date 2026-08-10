import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { EvidenceKind, LlmTier } from '@shared/enums';
import type { Citation } from '@shared/entities';
import type { ChatRequest, ProviderTestResult, StreamStarted, TokenUsage } from '@shared/ipc';
// 直接引 bridge 而非 ipc/index，避免与 handler 注册形成循环依赖
import { emit } from '../ipc/bridge';
import {
  appendMessage,
  appendToolCall,
  createSession,
} from '../session';
import { createRoleClient, createTierClient } from './client';
import { agentTools, AGENT_TOOLS, GRAPH_TOOLS, runTool, type ToolContext } from './tools';
import { getRepo, getRepoLocalPath } from '../repo/repository';
import { mergedCodeAgentTools, runCodeRepoTool } from '../repo/tools';
import { getCampaignRow } from '../campaign/repository';
import { decideSearchTrigger, triggerInstruction } from '../search/trigger';
import { normalizeChatMessages } from './messages';

/** 工具调用的最大轮数，防止 Agent 陷入反复检索 */
const MAX_TOOL_ROUNDS = 4;
const MAX_REPO_TOOL_ROUNDS = 8;

const active = new Map<string, AbortController>();

export function cancelStream(streamId: string): void {
  active.get(streamId)?.abort();
  active.delete(streamId);
}

export function startChat(req: ChatRequest): StreamStarted {
  const streamId = randomUUID();
  const controller = new AbortController();
  active.set(streamId, controller);
  void runChat(streamId, req, controller).finally(() => active.delete(streamId));
  return { streamId, sessionId: req.sessionId ?? null };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

interface StreamParams {
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  temperature: number | undefined;
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined;
}

/**
 * stream_options 用于拿 token 用量，但并非所有 OpenAI 兼容端点都认这个参数，
 * 不认的会直接返回 400。用量只是观测数据，不值得为它牺牲可用性——
 * 被拒时去掉该参数重试一次，代价是这次调用统计不到 token。
 */
async function openStream(
  client: OpenAI,
  controller: AbortController,
  { model, messages, temperature, tools }: StreamParams,
): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  const base = {
    model,
    messages,
    temperature,
    stream: true as const,
    ...(tools ? { tools } : {}),
  };

  try {
    return await client.chat.completions.create(
      { ...base, stream_options: { include_usage: true } },
      { signal: controller.signal },
    );
  } catch (err) {
    if (controller.signal.aborted) throw err;
    return client.chat.completions.create(base, { signal: controller.signal });
  }
}

async function runChat(
  streamId: string,
  req: ChatRequest,
  controller: AbortController,
): Promise<void> {
  const pendingToolRecords: Array<{
    name: string;
    args: Record<string, unknown>;
    summary: string;
    durationMs: number;
    /** 结果字符数，用于按比例摊分下一轮的 prompt 增量 */
    resultChars: number;
    tokenCost: number | null;
  }> = [];
  /** 每轮产生的工具调用在 pendingToolRecords 中的下标 */
  const toolIndexByRound: number[][] = [];

  let sessionId = req.sessionId ?? null;

  try {
    const role = req.repoId ? 'codeAgent' : req.role;
    const { client, model, temperature } = createRoleClient(role);

    const userMessages = req.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1]?.content ?? '对话';
    if (!sessionId) {
      sessionId = createSession(
        req.sessionKind ?? (req.repoId ? 'repoQa' : 'freeChat'),
        lastUser.slice(0, 80),
        req.campaignId ?? null,
      );
    }
    if (userMessages.length > 0) {
      appendMessage(sessionId, 'user', userMessages[userMessages.length - 1]!.content);
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = req.messages.map(
      (m) => ({ role: m.role, content: m.content }),
    );

    // 规则触发优先于 Agent 自主判断——模型对「我需不需要搜」判断不准
    let company: string | null = null;
    if (req.campaignId) {
      try {
        company = getCampaignRow(req.campaignId).company;
      } catch {
        company = null;
      }
    }
    const decision = decideSearchTrigger(lastUser, company);
    const instruction = req.allowWebSearch ? triggerInstruction(decision) : null;
    if (instruction) messages.unshift({ role: 'system', content: instruction });

    const toolCtx: ToolContext = { campaignId: req.campaignId ?? null, purpose: lastUser };

    let repoRoot: string | null = null;
    if (req.repoId) {
      const repo = getRepo(req.repoId);
      repoRoot = getRepoLocalPath(req.repoId);
      if (repo.status !== 'ready') {
        throw new Error('仓库尚未索引完成，请稍候');
      }
      messages.unshift({
        role: 'system',
        content:
          `你正在分析仓库：${repo.url}\n\n` +
          `## 项目摘要\n${repo.summaryMd ?? '（无）'}\n\n` +
          `## Repo Map（节选）\n${(repo.repoMapMd ?? '').slice(0, 8000)}\n\n` +
          '规则：所有代码结论必须带 `path:line` 引用；流程梳理用 mermaid 图，每步标注文件行号；' +
          '设计意图类问题可联网搜索 why。',
      });
    }

    const citations: Citation[] = [];
    let usedWeb = false;
    let usedCode = false;
    let finalText = '';
    let usage: TokenUsage | null = null;
    const totals: TokenUsage = { promptTokens: 0, completionTokens: 0 };
    let lastPromptTokens: number | null = null;
    const maxRounds = req.repoId ? MAX_REPO_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
    const tools = req.repoId
      ? mergedCodeAgentTools(toolCtx)
      : req.allowWebSearch || decision.trigger === 'required'
        ? agentTools(toolCtx)
        : // 不联网也仍可读写知识图谱，这部分不产生外部调用
          toolCtx.campaignId
          ? GRAPH_TOOLS
          : undefined;

    for (let round = 0; round <= maxRounds; round++) {
      const stream = await openStream(client, controller, {
        model,
        messages: normalizeChatMessages(messages),
        temperature,
        tools: tools && round < maxRounds ? tools : undefined,
      });

      let roundText = '';
      let roundUsage: TokenUsage | null = null;
      const pending = new Map<number, PendingToolCall>();

      for await (const chunk of stream) {
        if (chunk.usage) {
          roundUsage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          roundText += delta.content;
          emit('stream:delta', { streamId, delta: delta.content });
        }

        // tool_calls 是分片下发的，需要按 index 累积拼接
        for (const tc of delta.tool_calls ?? []) {
          const slot = pending.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(tc.index, slot);
        }
      }

      finalText += roundText;

      if (roundUsage) {
        totals.promptTokens += roundUsage.promptTokens;
        totals.completionTokens += roundUsage.completionTokens;
        // 本轮 prompt 比上一轮多出来的部分，正是上一轮工具结果塞进上下文的代价
        if (lastPromptTokens !== null) {
          chargeTools(
            pendingToolRecords,
            toolIndexByRound[round - 1] ?? [],
            roundUsage.promptTokens - lastPromptTokens,
          );
        }
        lastPromptTokens = roundUsage.promptTokens;
      }
      usage = roundUsage ?? usage;

      if (pending.size === 0) break;

      const roundToolIndexes: number[] = [];
      toolIndexByRound[round] = roundToolIndexes;

      messages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: [...pending.values()].map((p) => ({
          id: p.id,
          type: 'function' as const,
          function: { name: p.name, arguments: p.args || '{}' },
        })),
      });

      for (const call of pending.values()) {
        const startedAt = Date.now();
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.args || '{}') as Record<string, unknown>;
        } catch {
          // 模型偶尔会吐出非法 JSON，用空参数继续而不是直接失败
        }

        let outcome;
        try {
          outcome = repoRoot
            ? await runCodeRepoTool(call.name, args, repoRoot, controller.signal, {
                ...toolCtx,
                repoId: req.repoId,
              })
            : await runTool(call.name, args, controller.signal, toolCtx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outcome = { content: `工具执行失败: ${msg}`, summary: `${call.name} 失败`, citations: [] };
        }

        if (call.name === 'web_search' || call.name === 'fetch_url') usedWeb = true;
        if (['list_dir', 'read_file', 'grep'].includes(call.name)) usedCode = true;
        citations.push(...outcome.citations);

        emit('stream:tool', {
          streamId,
          toolName: call.name,
          args,
          resultSummary: outcome.summary,
          durationMs: Date.now() - startedAt,
        });

        roundToolIndexes.push(pendingToolRecords.length);
        pendingToolRecords.push({
          name: call.name,
          args,
          summary: outcome.summary,
          durationMs: Date.now() - startedAt,
          resultChars: outcome.content.length,
          tokenCost: null,
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: outcome.content,
        });
      }
    }

    // 最后一轮之后没有再次请求，拿不到真实增量，按结果长度估一个
    for (const tc of pendingToolRecords) {
      tc.tokenCost ??= estimateTokens(tc.resultChars);
    }

    const deduped = dedupeCitations(citations);
    const totalUsage = totals.promptTokens > 0 ? totals : usage;
    const evidenceKind: EvidenceKind = usedCode ? 'code' : usedWeb ? 'web' : 'model';
    if (sessionId) {
      const assistantMsgId = appendMessage(
        sessionId,
        'assistant',
        finalText,
        deduped,
        totalUsage,
        evidenceKind,
      );
      for (const tc of pendingToolRecords) {
        appendToolCall(
          assistantMsgId,
          tc.name,
          tc.args,
          tc.summary,
          tc.durationMs,
          tc.tokenCost,
        );
      }
    }

    emit('stream:done', {
      streamId,
      sessionId,
      contentMd: finalText,
      citations: deduped,
      evidenceKind,
      usage: totalUsage,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      emit('stream:done', {
        streamId,
        sessionId,
        contentMd: '',
        citations: [],
        evidenceKind: 'model',
        usage: null,
      });
      return;
    }
    emit('stream:error', {
      streamId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 中英混排下大约每 3 个字符一个 token，够用来做兜底估算 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

/**
 * 把一轮 prompt 的实际增量按结果长度摊到该轮的各个工具上。
 *
 * 工具本身不消耗 token，真正的开销是它塞进上下文的结果；下一轮 prompt
 * 比上一轮多出来的部分就是这笔账。摊分是近似的（增量里还含 assistant
 * 的 tool_calls 本身），但比拍脑袋估算贴近真实计费。
 */
function chargeTools(
  records: Array<{ resultChars: number; tokenCost: number | null }>,
  indexes: number[],
  promptDelta: number,
): void {
  if (indexes.length === 0 || promptDelta <= 0) return;

  const totalChars = indexes.reduce((s, i) => s + (records[i]?.resultChars ?? 0), 0);
  for (const i of indexes) {
    const rec = records[i];
    if (!rec) continue;
    rec.tokenCost =
      totalChars > 0
        ? Math.round((promptDelta * rec.resultChars) / totalChars)
        : Math.round(promptDelta / indexes.length);
  }
}

function dedupeCitations(list: Citation[]): Citation[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = c.url ?? `${c.filePath}:${c.startLine}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 连通性与能力探测。带 tools 发一次最小请求：
 * 成功说明支持 function calling（main 档的硬性要求），
 * 失败则退回不带 tools 再试一次，用于区分「不支持工具」和「压根连不上」。
 */
export async function testTier(tier: LlmTier): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  let model = '';

  try {
    const rc = createTierClient(tier);
    model = rc.model;

    try {
      await rc.client.chat.completions.create({
        model: rc.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        tools: AGENT_TOOLS,
      });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        model,
        message: '连通正常，支持 function calling',
        supportsToolCalling: true,
      };
    } catch {
      await rc.client.chat.completions.create({
        model: rc.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        model,
        message: '连通正常，但不支持 function calling（main 档角色不能用此模型）',
        supportsToolCalling: false,
      };
    }
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      model,
      message: err instanceof Error ? err.message : String(err),
      supportsToolCalling: null,
    };
  }
}
