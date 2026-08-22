import { normalizeDisplayText } from '@shared/lib/markdownDisplay';

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

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().startsWith('|');
}

function isTableDivider(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]*$/.test(line.trim());
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

    if (isTableRow(line)) {
      const tableLines: string[] = [];
      while (index < lines.length && isTableRow(lines[index]!)) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      const rows = tableLines.filter((row) => !isTableDivider(row));
      if (rows.length > 0) {
        const [head, ...body] = rows;
        const headerCells = head!
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean);
        parts.push('<table><thead><tr>');
        for (const cell of headerCells) {
          parts.push(`<th>${renderInlineMarkdown(cell)}</th>`);
        }
        parts.push('</tr></thead><tbody>');
        for (const row of body) {
          const cells = row
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean);
          parts.push('<tr>');
          for (const cell of cells) {
            parts.push(`<td>${renderInlineMarkdown(cell)}</td>`);
          }
          parts.push('</tr>');
        }
        parts.push('</tbody></table>');
      }
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
