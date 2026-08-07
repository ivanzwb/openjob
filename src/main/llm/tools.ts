import type OpenAI from 'openai';
import type { Citation } from '@shared/entities';
import { fetchUrl, search } from '../search';
import { compressForContext } from './compress';

/**
 * 交给模型的工具定义。描述里写清「什么时候不该用」和「必须引用出处」，
 * 因为模型对「我需不需要搜」的判断本身就不准，需要在 prompt 层面收紧。
 */
export const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网检索。适用于：公司/岗位相关的面经与面试流程、版本敏感的技术细节、时效性内容、开源项目的设计意图讨论。' +
        '不要用于稳定的基础知识（如 TCP 三次握手、红黑树、GC 算法原理），你自己知道得更准，检索只会引入噪音。' +
        '使用检索结果时必须在回答中标注来源链接。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，保留时间限定词' },
          freshness: {
            type: 'string',
            enum: ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'],
            description: '时效过滤。检索面经时应传 oneYear，避免采纳几年前的旧信息',
          },
          count: { type: 'number', description: '返回条数，默认 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        '抓取指定网页正文。当 web_search 返回的摘要不足以回答问题时，用它读原文。不要对无关链接滥用。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

/** 只在有 Campaign 上下文时开放，否则 nodeName 无从解析 */
export const GRAPH_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'query_graph',
      description:
        '查询当前备考战役的知识点树，返回考点的覆盖类型、考察概率、掌握度与优先级。' +
        '在需要知道「用户哪里薄弱」「该先学什么」时使用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按名称过滤，留空返回优先级最高的若干个' },
          limit: { type: 'number', description: '返回条数，默认 15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_mastery',
      description:
        '回写某个考点的掌握度（0-5）。仅在用户明确表达了掌握程度时使用，不要凭回答质量自行猜测打分。',
      parameters: {
        type: 'object',
        properties: {
          node_name: { type: 'string', description: '考点名称，需与 query_graph 返回的一致' },
          mastery: { type: 'number', description: '0-5' },
        },
        required: ['node_name', 'mastery'],
      },
    },
  },
];

export interface ToolContext {
  campaignId?: string | null;
  /** 用于压缩时判断哪些内容相关 */
  purpose?: string;
}

export function agentTools(ctx?: ToolContext): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return ctx?.campaignId ? [...AGENT_TOOLS, ...GRAPH_TOOLS] : AGENT_TOOLS;
}

export interface ToolOutcome {
  /** 回给模型的文本 */
  content: string;
  /** 供 UI 展示的一句话摘要 */
  summary: string;
  citations: Citation[];
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  ctx?: ToolContext,
): Promise<ToolOutcome> {
  if (name === 'web_search') {
    const query = String(args['query'] ?? '');
    const res = await search(
      {
        query,
        freshness: args['freshness'] as never,
        count: typeof args['count'] === 'number' ? args['count'] : 8,
      },
      signal,
    );

    const citations: Citation[] = res.results.map((r) => ({
      kind: 'web',
      url: r.url,
      title: r.title,
    }));

    // 正文先压缩再进上下文——真正贵的是这部分 token，不是搜索调用本身。
    // 只压缩排在最前的几条：结果已按可信度降序，靠后的本来也不该被重点采纳，
    // 为它们各发一次压缩请求不划算。
    const COMPRESS_TOP_N = 3;
    const blocks = await Promise.all(
      res.results.map(async (r, i) => {
        const raw = r.contentMd ?? r.snippet;
        const body =
          i < COMPRESS_TOP_N
            ? (await compressForContext(raw, ctx?.purpose ?? query, 900)).text
            : raw.slice(0, 600);
        return `[${i + 1}] ${r.title}\nURL: ${r.url}\n可信度: ${r.credibility}/5\n${body}`;
      }),
    );

    return {
      content: blocks.join('\n\n---\n\n') || '未检索到结果',
      summary: `${res.provider} 检索「${res.query}」${res.fromCache ? '（缓存）' : ''}，${res.results.length} 条结果`,
      citations,
    };
  }

  if (name === 'fetch_url') {
    const url = String(args['url'] ?? '');
    const res = await fetchUrl({ url }, signal);
    const { text, compressed } = await compressForContext(
      res.contentMd,
      ctx?.purpose ?? res.title,
      2000,
    );
    return {
      content: text,
      summary: `抓取 ${url}${compressed ? '（已压缩）' : ''}`,
      citations: [{ kind: 'web', url: res.url, title: res.title }],
    };
  }

  if (name === 'query_graph' || name === 'update_mastery') {
    // 延迟引入，避免 llm 层在模块加载期就依赖 campaign 层
    const { runGraphTool } = await import('./graphTools');
    return runGraphTool(name, args, ctx?.campaignId ?? null);
  }

  throw new Error(`未知工具: ${name}`);
}
