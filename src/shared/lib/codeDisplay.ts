/**
 * 部分模型会把代码围栏输出成「每行代码后都空一行」。这不是源码排版，而是生成
 * 格式噪声；在窄面板里会把可见内容直接砍半。只有当至少 70% 的相邻非空行之间
 * 都恰好夹着一个空行时才压缩，正常按逻辑分段的源码保持原样。
 */
export function compactArtificialBlankLines(code: string): string {
  const lines = code.split(/\r?\n/);
  const nonBlankIndexes = lines
    .map((line, index) => (line.trim() ? index : -1))
    .filter((index) => index >= 0);

  if (nonBlankIndexes.length < 4) return code;

  let isolatedBlankGaps = 0;
  for (let i = 1; i < nonBlankIndexes.length; i++) {
    if (nonBlankIndexes[i]! - nonBlankIndexes[i - 1]! === 2) isolatedBlankGaps++;
  }
  if (isolatedBlankGaps / (nonBlankIndexes.length - 1) < 0.7) return code;

  return lines
    .filter((line, index) => {
      if (line.trim()) return true;
      return !(lines[index - 1]?.trim() && lines[index + 1]?.trim());
    })
    .join('\n');
}
