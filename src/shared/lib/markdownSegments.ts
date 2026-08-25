import { findUnfencedCodeRunEnd } from './unfencedCode';

export type MarkdownTextSegment =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'code'; lines: string[] };

export type MarkdownLineKind = 'heading' | 'bullet' | 'numbered' | 'quote' | 'plain';

export interface MarkdownLine {
  kind: MarkdownLineKind;
  /** heading 的 # 个数，其它行恒为 0 */
  level: number;
  /** 去掉行首标记后的正文 */
  text: string;
  /** text 在原行里的起始下标，桌面端靠它把 DOM 偏移还原回 contentMd */
  contentStart: number;
}

const HEADING = /^(#{1,6}\s+)(.*)$/;
const BULLET = /^([-*+]\s+)(.*)$/;
const NUMBERED = /^(\d+[.)]\s+)(.*)$/;
const QUOTE = /^(>\s?)(.*)$/;

/** 识别一行的块级结构；缩进先剥掉，代码段已经在上游被切走了 */
export function parseMarkdownLine(line: string): MarkdownLine {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;

  const heading = HEADING.exec(trimmed);
  if (heading) {
    return {
      kind: 'heading',
      level: heading[1]!.trimEnd().length,
      text: heading[2]!,
      contentStart: indent + heading[1]!.length,
    };
  }

  for (const [kind, re] of [
    ['bullet', BULLET],
    ['numbered', NUMBERED],
    ['quote', QUOTE],
  ] as const) {
    const match = re.exec(trimmed);
    if (match) {
      return {
        kind,
        level: 0,
        text: match[2]!,
        contentStart: indent + match[1]!.length,
      };
    }
  }

  return { kind: 'plain', level: 0, text: trimmed, contentStart: indent };
}

export function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.startsWith('|');
}

export function isMarkdownTableDivider(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]*$/.test(line.trim());
}

/** 按 Markdown 管道表规则切分单元格，保留空列 */
export function splitMarkdownTableCells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split('|').map((cell) => cell.trim());
}

export function normalizeTableRows(rows: string[][]): string[][] {
  const colCount = Math.max(0, ...rows.map((row) => row.length));
  if (colCount === 0) return [];
  return rows.map((row) => {
    const out = row.slice(0, colCount);
    while (out.length < colCount) out.push('');
    return out;
  });
}

/** 把纯文本块拆成段落、表格与漏加围栏的代码，支持同一块里混排 */
export function parseMarkdownTextSegments(text: string): MarkdownTextSegment[] {
  const lines = text.split('\n');
  const segments: MarkdownTextSegment[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (isMarkdownTableRow(line)) {
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index]!)) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      const rows = normalizeTableRows(
        tableLines
          .filter((row) => !isMarkdownTableDivider(row))
          .map(splitMarkdownTableCells)
          .filter((row) => row.some((cell) => cell.length > 0)),
      );
      if (rows.length > 0) {
        segments.push({ type: 'table', rows });
        continue;
      }
    }

    const codeEnd = findUnfencedCodeRunEnd(lines, index);
    if (codeEnd !== null) {
      segments.push({ type: 'code', lines: lines.slice(index, codeEnd) });
      index = codeEnd;
      continue;
    }

    const paragraph: string[] = [];
    // 首行已经确认不是代码段开头，再判一次只会白跑；后续行则要随时让位给代码段
    while (
      index < lines.length &&
      !isMarkdownTableRow(lines[index]!) &&
      (paragraph.length === 0 || findUnfencedCodeRunEnd(lines, index) === null)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    if (paragraph.some((l) => l.trim().length > 0)) {
      segments.push({ type: 'paragraph', lines: paragraph });
    }
  }

  return segments;
}
