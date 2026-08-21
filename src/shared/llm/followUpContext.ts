import type { ChatMessage } from './messages';

/** 按中文接近 1 字/token 的保守估算，为回答预留足够窗口 */
export const FOLLOW_UP_CONTEXT_MAX_CHARS = 12_000;
const SUMMARY_CHUNK_MAX_CHARS = 8_000;
const MIN_RECENT_MESSAGES = 8;

export interface FollowUpStoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface FollowUpSummaryState {
  summary: string;
  throughMessageId: string | null;
  sourceCount: number;
}

export type FollowUpSummaryUpdate = FollowUpSummaryState;

interface CompactInput {
  systemPrompt: string;
  messages: FollowUpStoredMessage[];
  state: FollowUpSummaryState;
  summarize: (previousSummary: string, messages: FollowUpStoredMessage[]) => Promise<string>;
  saveSummary: (update: FollowUpSummaryUpdate) => Promise<void> | void;
  maxChars?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  compressed: boolean;
}

function messageChars(messages: FollowUpStoredMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length + 24, 0);
}

function contextChars(
  systemPrompt: string,
  summary: string,
  messages: FollowUpStoredMessage[],
): number {
  return systemPrompt.length + summary.length + messageChars(messages) + 500;
}

function summarySystemMessage(summary: string): ChatMessage | null {
  if (!summary.trim()) return null;
  return {
    role: 'system',
    content:
      '以下是更早对话的压缩摘要，仅用于理解背景。以最后一条“当前问题”为最高优先级；' +
      '不要继续回答摘要中的旧问题，除非当前问题明确引用；如有冲突，以当前问题为准。\n\n' +
      summary.trim(),
  };
}

/**
 * 将旧消息滚动压缩为摘要，同时始终保留最近消息和当前问题原文。
 * 原始消息不删除；这里只决定本次发给模型的上下文。
 */
export async function compactFollowUpContext(input: CompactInput): Promise<CompactResult> {
  const maxChars = input.maxChars ?? FOLLOW_UP_CONTEXT_MAX_CHARS;
  let summary = input.state.summary;
  let start = 0;

  if (input.state.throughMessageId) {
    const cursor = input.messages.findIndex(
      (message) => message.id === input.state.throughMessageId,
    );
    // 同步插入了更早消息或游标失效时，从原始历史重建，避免摘要漏内容。
    if (cursor >= 0 && cursor + 1 === input.state.sourceCount) {
      start = cursor + 1;
    } else {
      summary = '';
    }
  }

  let compressed = false;
  while (
    contextChars(input.systemPrompt, summary, input.messages.slice(start)) > maxChars &&
    input.messages.length - start > MIN_RECENT_MESSAGES
  ) {
    const latestCompressible = input.messages.length - MIN_RECENT_MESSAGES;
    let end = start;
    let chars = 0;
    while (end < latestCompressible) {
      const nextChars = input.messages[end].content.length + 24;
      if (end > start && chars + nextChars > SUMMARY_CHUNK_MAX_CHARS) break;
      chars += nextChars;
      end += 1;
    }
    if (end === start) break;

    const chunk = input.messages.slice(start, end);
    const nextSummary = (await input.summarize(summary, chunk)).trim();
    if (!nextSummary) throw new Error('追问历史压缩返回空摘要');
    summary = nextSummary.slice(0, 4_000);
    start = end;
    compressed = true;
    await input.saveSummary({
      summary,
      throughMessageId: chunk[chunk.length - 1].id,
      sourceCount: start,
    });
  }

  // 极长的最近回答可能单独超过预算；从最旧端丢弃，但永不丢当前问题。
  let recent = input.messages.slice(start);
  while (
    recent.length > 1 &&
    contextChars(input.systemPrompt, summary, recent) > maxChars
  ) {
    recent = recent.slice(1);
  }

  const summaryMessage = summarySystemMessage(summary);
  return {
    compressed,
    messages: [
      { role: 'system', content: input.systemPrompt },
      ...(summaryMessage ? [summaryMessage] : []),
      ...recent.map((message) => ({ role: message.role, content: message.content })),
    ],
  };
}

export function buildFollowUpSummaryPrompt(
  previousSummary: string,
  messages: FollowUpStoredMessage[],
): ChatMessage[] {
  const transcript = messages
    .map((message) => `${message.role === 'user' ? '用户' : '教练'}：${message.content}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        '你负责压缩面试备考追问历史。输出不超过 1200 个汉字的结构化摘要，只保留：' +
        '用户目标与已知前提、已经确认的结论、用户暴露的薄弱点或误区、尚未解决的问题、' +
        '后续回答必须遵守的约束。不要续答问题，不要添加原文没有的信息。',
    },
    {
      role: 'user',
      content:
        `${previousSummary ? `已有摘要：\n${previousSummary}\n\n` : ''}` +
        `需要合并的新对话：\n${transcript}`,
    },
  ];
}
