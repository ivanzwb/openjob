import { describe, expect, it } from 'vitest';
import {
  buildRepoQaThread,
  nextMessageTimestamp,
  repoQaSessionId,
  type RepoQaMessage,
} from './repoQaThread';

describe('repoQaSessionId', () => {
  it('同一个仓库拼出同一个会话 id', () => {
    expect(repoQaSessionId('r1')).toBe('repo-qa:r1');
    expect(repoQaSessionId('r1')).toBe(repoQaSessionId('r1'));
  });

  it('不同仓库不会串到一起', () => {
    expect(repoQaSessionId('r1')).not.toBe(repoQaSessionId('r2'));
  });
});

describe('nextMessageTimestamp', () => {
  it('首条消息直接用当前时间', () => {
    expect(nextMessageTimestamp(null, 1000)).toBe(1000);
  });

  it('同毫秒连写也要严格递增，否则问答顺序会错乱', () => {
    expect(nextMessageTimestamp(1000, 1000)).toBe(1001);
  });

  it('时间已经往前走了就用当前时间', () => {
    expect(nextMessageTimestamp(1000, 5000)).toBe(5000);
  });
});

describe('buildRepoQaThread', () => {
  const history: RepoQaMessage[] = [
    { role: 'user', text: '主流程怎么启动的？' },
    { role: 'assistant', text: '从 main.ts 开始' },
  ];

  it('把历史和当前问题按顺序拼成一条线程', () => {
    expect(buildRepoQaThread(history, '那配置从哪读？')).toEqual([
      { role: 'user', content: '主流程怎么启动的？' },
      { role: 'assistant', content: '从 main.ts 开始' },
      { role: 'user', content: '那配置从哪读？' },
    ]);
  });

  it('没有历史时只发当前问题', () => {
    expect(buildRepoQaThread([], '你好')).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('超预算时丢最旧的几轮，保留最近的上下文', () => {
    const long: RepoQaMessage[] = [
      { role: 'user', text: 'a'.repeat(60) },
      { role: 'assistant', text: 'b'.repeat(60) },
      { role: 'user', text: 'c'.repeat(60) },
      { role: 'assistant', text: 'd'.repeat(60) },
    ];
    const thread = buildRepoQaThread(long, '最新问题', 150);

    expect(thread.map((m) => m.content[0])).toEqual(['c', 'd', '最']);
    expect(thread.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(150);
  });

  it('当前问题本身超预算也绝不丢掉', () => {
    const thread = buildRepoQaThread(history, 'x'.repeat(500), 10);

    expect(thread).toHaveLength(1);
    expect(thread[0]).toEqual({ role: 'user', content: 'x'.repeat(500) });
  });
});
