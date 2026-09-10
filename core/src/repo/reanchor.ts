/**
 * 仓库更新后，把旧代码引用重新定位到新文件里。
 *
 * 引用存的是 path + 行号，代码一改行号就漂了，挂在引用上的标记和笔记会指向
 * 无关的代码——比指向不存在的行更糟，因为它看起来是对的。所以拿当初存下来的
 * 片段回到新文件里找，找到了就把行号挪过去，找不到就别动，让它保持旧 commit
 * 的记录（调用方据此判定失效）。
 *
 * 两个坑都在存进来的 snippet 上：
 * 1. 它是 readFileRange 的输出，每行带 `41|` 行号前缀，不剥掉一处都匹配不上；
 * 2. 落库时按 4000 字截断过，最后一行可能是半行，所以尾行只能按前缀比。
 */

/** 单行片段短于这个长度就不猜了：`}`、`);` 这种满文件都是，猜错比失效更坏 */
const MIN_ANCHOR_CHARS = 4;

const LINE_NUMBER_PREFIX = /^\d+\|/;

export interface AnchorRef {
  /** 当初存下的片段，可能带行号前缀、可能被截断 */
  snippet: string;
  /** 旧行号，用来在多处相同代码里挑最近的那处 */
  startLine: number;
  endLine: number;
}

export interface AnchorResult {
  startLine: number;
  endLine: number;
}

function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** 片段还原成待查的行序列：剥行号前缀、去掉尾部空行 */
function needleLines(snippet: string): string[] {
  const lines = toLines(snippet).map((l) => l.replace(LINE_NUMBER_PREFIX, ''));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * 返回所有匹配处的起始行（1 基）。
 * loose 为真时忽略两侧空白，用来兜住只是重新缩进过的代码。
 */
function findMatches(fileLines: string[], needle: string[], loose: boolean): number[] {
  const norm = (s: string): string => (loose ? s.trim() : s);
  const lastIndex = needle.length - 1;
  const out: number[] = [];

  for (let i = 0; i + needle.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      const line = norm(fileLines[i + j]);
      const want = norm(needle[j]);
      // 尾行按前缀比：截断过的片段最后一行本来就是半行
      if (j === lastIndex ? !line.startsWith(want) : line !== want) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i + 1);
  }
  return out;
}

export function reanchorSnippet(fileContent: string, ref: AnchorRef): AnchorResult | null {
  const needle = needleLines(ref.snippet);
  if (needle.length === 0) return null;
  if (needle.length === 1 && needle[0].trim().length < MIN_ANCHOR_CHARS) return null;

  const fileLines = toLines(fileContent);
  const strict = findMatches(fileLines, needle, false);
  const candidates = strict.length > 0 ? strict : findMatches(fileLines, needle, true);
  if (candidates.length === 0) return null;

  // 同一段代码在文件里出现多次时（重复样板、相似分支），离原位置最近的那处
  // 最可能就是当初引用的那处
  const startLine = candidates.reduce((best, c) =>
    Math.abs(c - ref.startLine) < Math.abs(best - ref.startLine) ? c : best,
  );

  // 跨度沿用旧的：代码涨了还是缩了没法从片段看出来，
  // 而截断过的片段行数本来就少于原跨度，照它算会把引用越缩越小
  const span = Math.max(0, ref.endLine - ref.startLine);
  return { startLine, endLine: Math.min(startLine + span, fileLines.length) };
}
