/**
 * 无围栏代码识别。
 *
 * 模型经常忘记给代码加 ``` 围栏，渲染端就把整段代码当正文排版：等宽字体、
 * 缩进、横向滚动全没了，多行代码挤成一坨没法读。prompt 侧已经要求加围栏，
 * 但模型不保证遵守，这里做渲染兜底。
 *
 * 判定必须保守——把中文正文误判成代码比漏判难受得多：正文一旦进代码块就
 * 丢掉行内 markdown、换成小号等宽字，整段观感崩掉；漏判只是维持现状。
 * 所以强特征（分号结尾、声明关键字、赋值、整行调用……）才有资格起头，
 * 缩进、注释这类弱信号只能延续已经起头的代码段。
 */

/** 一段代码至少要有这么多行，避免把正文里孤零零一行伪代码拎出来 */
const MIN_RUN_LINES = 2;
/** 一段代码至少要有这么多行命中强特征，只靠缩进凑不出代码块 */
const MIN_STRONG_LINES = 2;
/** 代码段内部允许的连续空行数，超过就认为代码结束了 */
const MAX_BLANK_GAP = 1;

/** 中文句子的收尾标点。带这些的行是正文，哪怕里面出现了 => 之类的符号 */
const CJK_SENTENCE_END = /[。！？；：、，]\s*$/;

/**
 * 强特征：命中任意一条就认为这行是代码。
 *
 * 赋值与整行调用都要求以 ASCII 标识符开头，中文正文的「准确率 = 0.95」
 * 「时间复杂度 O(n)」因此不会命中。
 */
const STRONG_CODE_PATTERNS: RegExp[] = [
  /^(?:export\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|async\s+)*(?:function|def|class|const|let|var|import|from|return|func|fn|struct|impl|trait|interface|type|enum|package|namespace|using|module)\b/,
  /^(?:if|for|while|switch|catch|foreach)\s*\(/,
  /^(?:if|elif|else|for|while|try|except|finally|with|def|class|switch|case)\b[^\u4e00-\u9fff]*:$/,
  /^#(?:include|define|pragma|import|ifdef|ifndef|endif)\b/,
  /;\s*$/,
  /^[{}()[\]]+[;,]?$/,
  /=>/,
  /^[A-Za-z_$][\w.$[\], ]*=[^=]/,
  /^[A-Za-z_$][\w.$]*\(.*\)[;,]?$/,
  /^<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/,
];

/** 弱特征：只能跟在代码段后面，自己不能起头 */
const CONTINUATION_PATTERNS: RegExp[] = [
  /^(?: {2,}|\t)/,
  /^[{}()[\]]/,
  /^(?:\/\/|\/\*|\*\/|\*\s)/,
];

/**
 * markdown 结构行永远是正文，不进代码段。
 *
 * 标题只认缩进 ≤3 空格的写法：代码里的 Python / Shell 注释常常是缩进过的
 * `    # 说明`，按 markdown 规矩那已经不是标题了，放行才能让带中文注释的
 * 代码段不被从中间劈开。
 */
const PROSE_PATTERNS: RegExp[] = [
  /^ {0,3}#{1,6}\s/,
  /^\s*(?:[-*+]|\d+[.)])\s/,
  /^ {0,3}>\s/,
  /^\s*(?:```|~~~)/,
  /^\s*\|/,
];

function isProseLine(line: string): boolean {
  return PROSE_PATTERNS.some((re) => re.test(line));
}

export function isStrongCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isProseLine(line)) return false;
  if (CJK_SENTENCE_END.test(trimmed)) return false;
  return STRONG_CODE_PATTERNS.some((re) => re.test(trimmed));
}

function isContinuationLine(line: string): boolean {
  if (!line.trim()) return false;
  if (isProseLine(line)) return false;
  return CONTINUATION_PATTERNS.some((re) => re.test(line));
}

/**
 * 从 from 开始找一段无围栏代码，返回结束行号（不含）。不构成代码段时返回 null。
 */
export function findUnfencedCodeRunEnd(lines: string[], from: number): number | null {
  if (!isStrongCodeLine(lines[from] ?? '')) return null;

  let end = from;
  let strongCount = 0;
  let blankGap = 0;
  let index = from;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      blankGap += 1;
      if (blankGap > MAX_BLANK_GAP) break;
      index += 1;
      continue;
    }
    if (isStrongCodeLine(line)) {
      strongCount += 1;
      blankGap = 0;
      index += 1;
      end = index;
      continue;
    }
    // 空行之后再出现弱特征行说明是新段落了，只有强特征行才能跨空行接回来
    if (blankGap === 0 && isContinuationLine(line)) {
      index += 1;
      end = index;
      continue;
    }
    break;
  }

  if (strongCount < MIN_STRONG_LINES) return null;
  if (end - from < MIN_RUN_LINES) return null;
  return end;
}
