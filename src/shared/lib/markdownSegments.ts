export type MarkdownTextSegment =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'table'; rows: string[][] };

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

/** 把纯文本块拆成段落与表格，支持同一块里混排 */
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

    const paragraph: string[] = [];
    while (index < lines.length && !isMarkdownTableRow(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    if (paragraph.some((l) => l.trim().length > 0)) {
      segments.push({ type: 'paragraph', lines: paragraph });
    }
  }

  return segments;
}
