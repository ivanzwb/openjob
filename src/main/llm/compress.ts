import { completeJson } from './json';

/** 超过这个长度才值得多花一次调用去压缩 */
const COMPRESS_THRESHOLD = 3000;
const TARGET_CHARS = 1200;

const SYSTEM = `你是上下文压缩器。把网页正文压成要点，供另一个模型回答问题时引用。
- 只保留与问题相关的事实、数字、结论、代码片段
- 丢弃导航栏、广告、评论、无关寒暄、重复内容
- 保留原文中的关键术语与专有名词，不要改写成同义词
- 不要添加原文没有的信息

输出 JSON：{ "digest": "压缩后的要点，markdown 分点" }`;

/**
 * 网页正文进上下文前先摘要。
 *
 * 真正贵的是塞进上下文的 token，不是搜索调用本身——一次便宜模型的压缩调用
 * 换掉几千 token 的原文是划算的。压缩失败时退回截断，不能因此让整条链路挂掉。
 */
export async function compressForContext(
  text: string,
  purpose: string,
  maxChars = TARGET_CHARS,
): Promise<{ text: string; compressed: boolean }> {
  const trimmed = text.trim();
  if (trimmed.length <= COMPRESS_THRESHOLD) {
    return { text: trimmed, compressed: false };
  }

  try {
    const res = await completeJson<{ digest: string }>(
      'explain',
      SYSTEM,
      `目的：${purpose}\n\n正文：\n${trimmed.slice(0, 24000)}`,
    );
    const digest = res.digest?.trim();
    if (digest) return { text: digest.slice(0, maxChars * 2), compressed: true };
  } catch {
    // 压缩是优化不是必需，失败就退回截断
  }

  return { text: trimmed.slice(0, maxChars), compressed: false };
}
