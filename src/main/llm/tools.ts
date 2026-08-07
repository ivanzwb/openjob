import type OpenAI from 'openai';
import type { Citation } from '@shared/entities';
import { fetchUrl, search } from '../search';

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
): Promise<ToolOutcome> {
  if (name === 'web_search') {
    const res = await search(
      {
        query: String(args['query'] ?? ''),
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

    // 正文截断后再进上下文——真正贵的是这部分 token，不是搜索调用本身
    const content = res.results
      .map((r, i) => {
        const body = (r.contentMd ?? r.snippet).slice(0, 1500);
        return `[${i + 1}] ${r.title}\nURL: ${r.url}\n可信度: ${r.credibility}/5\n${body}`;
      })
      .join('\n\n---\n\n');

    return {
      content: content || '未检索到结果',
      summary: `${res.provider} 检索「${res.query}」${res.fromCache ? '（缓存）' : ''}，${res.results.length} 条结果`,
      citations,
    };
  }

  if (name === 'fetch_url') {
    const url = String(args['url'] ?? '');
    const res = await fetchUrl({ url }, signal);
    return {
      content: res.contentMd.slice(0, 8000),
      summary: `抓取 ${url}`,
      citations: [{ kind: 'web', url: res.url, title: res.title }],
    };
  }

  throw new Error(`未知工具: ${name}`);
}
