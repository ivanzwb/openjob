/**
 * 把模型偶发输出的字面量 \n 还原成换行，便于展示。
 *
 * 只在代码围栏之外替换：代码示例里的 "\n" 是内容本身（比如 println("a\nb")），
 * 一起改掉会把示例代码改错。整段没有真实换行时说明模型是拿 \n 当换行用的，
 * 这时也不可能存在合法的围栏，直接整段替换。
 */
export function normalizeDisplayText(text: string): string {
  const unified = text.replace(/\r\n/g, '\n');
  if (!unified.includes('\n')) return unified.replace(/\\n/g, '\n');

  let inFence = false;
  return unified
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(/\\n/g, '\n');
    })
    .join('\n');
}
