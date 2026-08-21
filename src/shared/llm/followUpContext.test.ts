import { describe, expect, it, vi } from 'vitest';
import {
  compactFollowUpContext,
  type FollowUpStoredMessage,
} from './followUpContext';

function history(count: number, chars = 180): FollowUpStoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${index}:` + '问'.repeat(chars),
  }));
}

describe('compactFollowUpContext', () => {
  it('keeps short conversations verbatim without summarizing', async () => {
    const messages = history(4, 20);
    const summarize = vi.fn();
    const result = await compactFollowUpContext({
      systemPrompt: '聚焦当前问题',
      messages,
      state: { summary: '', throughMessageId: null, sourceCount: 0 },
      summarize,
      saveSummary: vi.fn(),
      maxChars: 2_000,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.messages.at(-1)?.content).toBe(messages.at(-1)?.content);
  });

  it('summarizes old chunks while retaining recent messages and current question', async () => {
    const messages = history(14);
    const saveSummary = vi.fn();
    const result = await compactFollowUpContext({
      systemPrompt: '聚焦当前问题',
      messages,
      state: { summary: '', throughMessageId: null, sourceCount: 0 },
      summarize: async () => '已压缩的历史',
      saveSummary,
      maxChars: 2_200,
    });

    expect(result.compressed).toBe(true);
    expect(saveSummary).toHaveBeenCalled();
    expect(result.messages.some((message) => message.content.includes('已压缩的历史'))).toBe(true);
    expect(result.messages.at(-1)?.content).toBe(messages.at(-1)?.content);
    expect(result.messages.some((message) => message.content === messages[0].content)).toBe(false);
  });

  it('rebuilds a stale summary cursor after earlier messages are inserted', async () => {
    const messages = history(12);
    const summarize = vi.fn(async (previous: string) =>
      previous ? `${previous}+新摘要` : '重建摘要',
    );
    await compactFollowUpContext({
      systemPrompt: '聚焦当前问题',
      messages,
      state: {
        summary: '旧摘要',
        throughMessageId: 'm-2',
        sourceCount: 2,
      },
      summarize,
      saveSummary: vi.fn(),
      maxChars: 2_000,
    });

    expect(summarize).toHaveBeenCalled();
    expect(summarize.mock.calls[0]?.[0]).toBe('');
  });
});
