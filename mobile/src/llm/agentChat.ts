import type { SQLiteDatabase } from 'expo-sqlite';
import type { Repo } from '@shared/entities';
import type { Citation } from '@shared/entities';
import { normalizeChatMessages, type ChatMessage } from '@shared/llm/messages';
import { searchWeb } from '../search';
import { resolveLlmRole } from './resolve';
import { CODE_REPO_TOOL_DEFS, runCodeRepoTool } from '../data/repoTools';
import { countRepoFiles } from '../data/repoFiles';

const MAX_REPO_TOOL_ROUNDS = 8;

const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      '联网检索。适用于公司/岗位面经、版本敏感技术细节、开源项目设计意图讨论。' +
      '不要用于稳定基础知识。使用检索结果时须标注来源链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        freshness: {
          type: 'string',
          enum: ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'],
        },
        count: { type: 'number' },
      },
      required: ['query'],
    },
  },
};

type ApiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

async function runWebSearch(args: Record<string, unknown>): Promise<{
  content: string;
  summary: string;
  citations: Citation[];
}> {
  const query = String(args['query'] ?? '');
  const res = await searchWeb(query, {
    freshness: args['freshness'] as never,
    count: typeof args['count'] === 'number' ? args['count'] : 8,
  });
  const citations: Citation[] = res.results.map((r) => ({
    kind: 'web',
    url: r.url,
    title: r.title,
  }));
  const blocks = res.results.map(
    (r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n可信度: ${r.credibility}/5\n${(r.contentMd ?? r.snippet).slice(0, 800)}`,
  );
  return {
    content: blocks.join('\n\n---\n\n') || '未检索到结果',
    summary: `${res.provider} 检索「${res.query}」${res.results.length} 条`,
    citations,
  };
}

function repoSystemPrompt(repo: Repo, syncedFiles: number): string {
  return (
    `你正在分析仓库：${repo.url}\n` +
    `手机端已同步 ${syncedFiles} 个文本文件，可用 list_dir / read_file / grep 读源码。\n\n` +
    `## 项目摘要\n${repo.summaryMd ?? '（无）'}\n\n` +
    `## Repo Map（节选）\n${(repo.repoMapMd ?? '').slice(0, 8000)}\n\n` +
    '规则：所有代码结论必须带 `path:line` 引用；流程梳理可用 mermaid 图并标注文件行号；' +
    '设计意图类问题可联网搜索 why。'
  );
}

export async function completeRepoAgentChat(
  db: SQLiteDatabase,
  repo: Repo,
  messages: ChatMessage[],
  opts?: { allowWebSearch?: boolean; signal?: AbortSignal },
): Promise<string> {
  const { baseUrl, model, apiKey, temperature } = await resolveLlmRole('codeAgent');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const syncedFiles = countRepoFiles(db, repo.id);
  const tools = [
    ...CODE_REPO_TOOL_DEFS,
    ...(opts?.allowWebSearch !== false ? [WEB_SEARCH_TOOL] : []),
  ];

  const apiMessages: ApiMessage[] = [
    { role: 'system', content: repoSystemPrompt(repo, syncedFiles) },
    ...normalizeChatMessages(messages).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  let finalText = '';

  for (let round = 0; round <= MAX_REPO_TOOL_ROUNDS; round++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        temperature: temperature ?? 0.3,
        stream: false,
        ...(round < MAX_REPO_TOOL_ROUNDS ? { tools } : {}),
      }),
      signal: opts?.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) break;

    if (message.content) finalText += message.content;

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) break;

    apiMessages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // ignore bad JSON from model
      }

      let outcome;
      try {
        if (call.function.name === 'web_search') {
          outcome = await runWebSearch(args);
        } else {
          outcome = runCodeRepoTool(call.function.name, args, db, repo.id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = { content: `工具执行失败: ${msg}`, summary: `${call.function.name} 失败`, citations: [] };
      }

      apiMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.content,
      });
    }
  }

  return finalText.trim();
}
