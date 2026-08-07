import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { LlmRole } from '@shared/enums';
import type { Citation } from '@shared/entities';
import type { ChatRequest, ProviderTestResult, StreamStarted } from '@shared/ipc';
// 直接引 bridge 而非 ipc/index，避免与 handler 注册形成循环依赖
import { emit } from '../ipc/bridge';
import { createRoleClient } from './client';
import { AGENT_TOOLS, runTool } from './tools';

/** 工具调用的最大轮数，防止 Agent 陷入反复检索 */
const MAX_TOOL_ROUNDS = 4;

const active = new Map<string, AbortController>();

export function cancelStream(streamId: string): void {
  active.get(streamId)?.abort();
  active.delete(streamId);
}

export function startChat(req: ChatRequest): StreamStarted {
  const streamId = randomUUID();
  const controller = new AbortController();
  active.set(streamId, controller);
  // 不 await：立即把 streamId 返回给渲染进程，内容通过事件推送
  void runChat(streamId, req, controller).finally(() => active.delete(streamId));
  return { streamId };
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
  try {
    const { client, model, temperature } = createRoleClient(req.role);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = req.messages.map(
      (m) => ({ role: m.role, content: m.content }),
    );

    const citations: Citation[] = [];
    let usedWeb = false;
    let finalText = '';
    let usage: { promptTokens: number; completionTokens: number } | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = await openStream(client, controller, {
        model,
        messages,
        temperature,
        tools: req.allowWebSearch && round < MAX_TOOL_ROUNDS ? AGENT_TOOLS : undefined,
      });

      let roundText = '';
      const pending = new Map<number, PendingToolCall>();

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
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

      if (pending.size === 0) break;

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
          outcome = await runTool(call.name, args, controller.signal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outcome = { content: `工具执行失败: ${msg}`, summary: `${call.name} 失败`, citations: [] };
        }

        if (call.name === 'web_search' || call.name === 'fetch_url') usedWeb = true;
        citations.push(...outcome.citations);

        emit('stream:tool', {
          streamId,
          toolName: call.name,
          args,
          resultSummary: outcome.summary,
          durationMs: Date.now() - startedAt,
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: outcome.content,
        });
      }
    }

    emit('stream:done', {
      streamId,
      contentMd: finalText,
      citations: dedupeCitations(citations),
      evidenceKind: usedWeb ? 'web' : 'model',
      usage,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      emit('stream:done', {
        streamId,
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
 * 成功说明支持 function calling（codeAgent 角色的硬性要求），
 * 失败则退回不带 tools 再试一次，用于区分「不支持工具」和「压根连不上」。
 */
export async function testRole(role: LlmRole): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  let model = '';

  try {
    const rc = createRoleClient(role);
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
        message: '连通正常，但不支持 function calling（codeAgent 角色不能用此模型）',
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
