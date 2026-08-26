import type { ChatMessage } from '@shared/llm/messages';

export type RepoQaMessage = { role: 'user' | 'assistant'; text: string };

/**
 * 源码问答的历史预算。
 *
 * 没走追问那套 LLM 摘要压缩：追问是一条连贯的辅导对话，早期前提丢了后面就答歪；
 * 源码问答每一轮基本各问各的，而且每轮都会用 list_dir / read_file / grep 重新读源码，
 * 真正撑爆窗口的是工具回读的文件内容，不是历史本身。为它多付一次 codeAgent 的
 * 摘要往返（本就是非流式、最多八轮工具调用）不划算，这里按字数丢最旧的几轮。
 */
export const REPO_QA_HISTORY_MAX_CHARS = 8_000;

/**
 * 每个仓库一条固定会话。session 表没有 repo_id，靠 id 拼出来找，
 * 这样两端离线各自先发问也会落到同一个会话，同步后自然汇合。
 */
export function repoQaSessionId(repoId: string): string {
  return `repo-qa:${repoId}`;
}

/**
 * 历史按 created_at 排序，同毫秒写入就只能靠随机 UUID 决胜负，问答顺序会错乱。
 * 所以新消息的时间戳至少比上一条大 1。
 */
export function nextMessageTimestamp(lastCreatedAt: number | null, now: number): number {
  if (lastCreatedAt === null) return now;
  return Math.max(now, lastCreatedAt + 1);
}

/** 组装这一轮发给模型的对话：末尾永远是当前问题，超预算就从最旧的丢起 */
export function buildRepoQaThread(
  history: RepoQaMessage[],
  question: string,
  maxChars = REPO_QA_HISTORY_MAX_CHARS,
): ChatMessage[] {
  const thread: RepoQaMessage[] = [...history, { role: 'user', text: question }];

  let chars = thread.reduce((sum, message) => sum + message.text.length, 0);
  let start = 0;
  // 当前问题再长也不能丢，它才是这一轮要回答的东西
  while (start < thread.length - 1 && chars > maxChars) {
    chars -= thread[start].text.length;
    start += 1;
  }

  return thread.slice(start).map((message) => ({
    role: message.role,
    content: message.text,
  }));
}
