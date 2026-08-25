import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import {
  isMarkdownTableDivider,
  isMarkdownTableRow,
  normalizeTableRows,
  splitMarkdownTableCells,
} from '@shared/lib/markdownSegments';

export { normalizeDisplayText };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function renderTableHtml(tableLines: string[]): string {
  const rows = normalizeTableRows(
    tableLines
      .filter((row) => !isMarkdownTableDivider(row))
      .map(splitMarkdownTableCells)
      .filter((row) => row.some((cell) => cell.length > 0)),
  );
  if (rows.length === 0) return '';

  const [head, ...body] = rows;
  const parts: string[] = ['<div class="table-wrap"><table><thead><tr>'];
  for (const cell of head!) {
    parts.push(`<th>${renderInlineMarkdown(cell)}</th>`);
  }
  parts.push('</tr></thead><tbody>');
  for (const row of body) {
    parts.push('<tr>');
    for (const cell of row) {
      parts.push(`<td>${renderInlineMarkdown(cell)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table></div>');
  return parts.join('');
}

/** 轻量 markdown → HTML，覆盖标题、列表、表格与代码块，供 WebView 阅读模式使用 */
export function markdownToDisplayHtml(text: string): string {
  const normalized = normalizeDisplayText(text);
  const lines = normalized.split('\n');
  const parts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith('```')) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1;
      parts.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`,
      );
      continue;
    }

    if (isMarkdownTableRow(line)) {
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index]!)) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      const tableHtml = renderTableHtml(tableLines);
      if (tableHtml) parts.push(tableHtml);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1]!.length;
      parts.push(`<h${level}>${renderInlineMarkdown(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
    const numbered = /^\d+\.\s+(.+)$/.exec(line.trim());
    if (bullet || numbered) {
      parts.push(`<p>${bullet ? '• ' : ''}${renderInlineMarkdown((bullet?.[1] ?? numbered?.[1])!)}</p>`);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      parts.push('<br/>');
      index += 1;
      continue;
    }

    parts.push(`<p>${renderInlineMarkdown(line)}</p>`);
    index += 1;
  }

  return parts.join('');
}
