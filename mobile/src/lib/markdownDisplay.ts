import type { Annotation } from '@shared/entities';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import {
  isMarkdownTableDivider,
  isMarkdownTableRow,
  normalizeTableRows,
  parseMarkdownLine,
  splitMarkdownTableCells,
} from '@shared/lib/markdownSegments';
import { parseInlineMarkdown, type InlineToken } from '@shared/lib/markdownInline';
import { findUnfencedCodeRunEnd } from '@shared/lib/unfencedCode';

export { normalizeDisplayText };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonAttr(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

function inlineTagPair(token: InlineToken): [string, string] {
  switch (token.kind) {
    case 'bold':
      return ['<strong>', '</strong>'];
    case 'italic':
      return ['<em>', '</em>'];
    case 'code':
      return ['<code>', '</code>'];
    case 'link':
      return [`<a href="${escapeHtml(token.href ?? '')}">`, '</a>'];
    default:
      return ['', ''];
  }
}

function renderInlineMarkdown(text: string): string {
  return parseInlineMarkdown(text)
    .map((token) => {
      const [open, close] = inlineTagPair(token);
      return `${open}${escapeHtml(token.text)}${close}`;
    })
    .join('');
}

type SourceRange = {
  start: number;
  end: number;
  highlightColor?: string;
  markerIds: string[];
  badge: string;
};

type InlineBuild = {
  html: string;
  visible: string;
  visibleToMd: number[];
};

function annotationStart(contentMd: string, mark: Annotation): number | undefined {
  const selected = mark.selectedText?.trim();
  if (!selected) return undefined;
  if (
    mark.selectionStart != null &&
    contentMd.slice(mark.selectionStart, mark.selectionStart + selected.length) === selected
  ) {
    return mark.selectionStart;
  }
  const fallback = contentMd.indexOf(selected);
  return fallback >= 0 ? fallback : undefined;
}

function collectAnnotationRanges(
  contentMd: string,
  annotations: Annotation[],
  defaultHighlightColor: string,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const mark of annotations) {
    if (mark.kind !== 'highlight' && mark.kind !== 'note' && mark.kind !== 'elaboration') continue;
    const selected = mark.selectedText?.trim();
    const start = annotationStart(contentMd, mark);
    if (!selected || start === undefined) continue;
    const end = start + selected.length;
    const existing = ranges.find((r) => r.start === start && r.end === end);
    if (existing) {
      if (mark.kind === 'highlight') {
        existing.highlightColor = mark.highlightColor ?? defaultHighlightColor;
      } else {
        existing.markerIds.push(mark.id);
      }
      const kinds = existing.markerIds.map(
        (id) => annotations.find((a) => a.id === id)?.kind,
      );
      const hasNote = kinds.includes('note');
      const hasElab = kinds.includes('elaboration');
      existing.badge =
        hasNote && hasElab ? '笔/细' : hasNote ? '笔' : hasElab ? '细' : '';
      continue;
    }
    const overlaps = ranges.some((r) => !(end <= r.start || start >= r.end));
    if (overlaps) continue;
    const markerIds =
      mark.kind === 'note' || mark.kind === 'elaboration' ? [mark.id] : [];
    ranges.push({
      start,
      end,
      ...(mark.kind === 'highlight'
        ? { highlightColor: mark.highlightColor ?? defaultHighlightColor }
        : {}),
      markerIds,
      badge:
        mark.kind === 'note'
          ? '笔'
          : mark.kind === 'elaboration'
            ? '细'
            : '',
    });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function rangeAt(ranges: SourceRange[], pos: number): SourceRange | undefined {
  return ranges.find((r) => pos >= r.start && pos < r.end);
}

function spanOpenTag(range: SourceRange): string {
  const classes = [
    range.highlightColor ? 'highlight-mark' : '',
    range.markerIds.length ? 'annotation-mark' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = range.highlightColor
    ? ` style="background:${escapeHtml(range.highlightColor)}"`
    : '';
  const badge = range.badge ? ` data-badge="${escapeHtml(range.badge)}"` : '';
  const ids = range.markerIds.join(' ');
  const idAttr = ids ? ` data-annotation-id="${escapeHtml(ids)}"` : '';
  const click = ids ? ` onclick="openMarkerMenu(event, '${escapeHtml(ids)}')"` : '';
  return `<span class="${classes}"${style}${idAttr}${badge}${click}>`;
}

function sameSpan(rangeA: SourceRange | undefined, rangeB: SourceRange | undefined): boolean {
  if (!rangeA && !rangeB) return true;
  if (!rangeA || !rangeB) return false;
  return (
    rangeA.start === rangeB.start &&
    rangeA.end === rangeB.end &&
    rangeA.highlightColor === rangeB.highlightColor &&
    rangeA.markerIds.join() === rangeB.markerIds.join()
  );
}

function renderInlineMarkdownWithMap(
  text: string,
  baseOffset: number,
  ranges: SourceRange[],
): InlineBuild {
  let html = '';
  let visible = '';
  const visibleToMd: number[] = [];
  let openRange: SourceRange | undefined;
  let openTag = '';

  const closeSpan = (): void => {
    if (openTag) {
      html += '</span>';
      openTag = '';
      openRange = undefined;
    }
  };

  const pushVisible = (ch: string, mdIndex: number): void => {
    const active = rangeAt(ranges, mdIndex);
    if (!sameSpan(openRange, active)) {
      closeSpan();
      if (active) {
        openTag = spanOpenTag(active);
        html += openTag;
        openRange = active;
      }
    }
    visible += ch;
    visibleToMd.push(mdIndex);
    html += escapeHtml(ch);
  };

  for (const token of parseInlineMarkdown(text, baseOffset)) {
    const [open, close] = inlineTagPair(token);
    html += open;
    for (let j = 0; j < token.text.length; j++) {
      pushVisible(token.text[j]!, token.start + j);
    }
    // 高亮 span 必须收在行内标签里面，否则 <strong><span>x</strong> 会嵌错
    if (close) closeSpan();
    html += close;
  }
  closeSpan();
  return { html, visible, visibleToMd };
}

function wrapMdBlock(
  innerHtml: string,
  visible: string,
  visibleToMd: number[],
  mdStart: number,
): string {
  return `<div class="md-block" data-md-start="${mdStart}" data-visible-map="${jsonAttr(visibleToMd)}">${innerHtml}</div>`;
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

function renderTableBlockWithMap(
  tableLines: string[],
  tableStart: number,
  ranges: SourceRange[],
): string {
  const rows = normalizeTableRows(
    tableLines
      .filter((row) => !isMarkdownTableDivider(row))
      .map(splitMarkdownTableCells)
      .filter((row) => row.some((cell) => cell.length > 0)),
  );
  if (rows.length === 0) return '';

  let rowStart = tableStart;
  let visible = '';
  const visibleToMd: number[] = [];
  const rowHtmls: string[] = [];
  let isFirstRow = true;

  for (const rowLine of tableLines) {
    if (isMarkdownTableDivider(rowLine)) {
      rowStart += rowLine.length + 1;
      continue;
    }
    const cells = splitMarkdownTableCells(rowLine);
    const cellHtmls: string[] = [];
    let searchAt = 0;
    for (const cell of cells) {
      const idx = rowLine.indexOf(cell, searchAt);
      const trimLead = cell.length - cell.trimStart().length;
      const cellContentStart = rowStart + (idx >= 0 ? idx : searchAt) + trimLead;
      const inline = renderInlineMarkdownWithMap(cell.trim(), cellContentStart, ranges);
      cellHtmls.push(inline.html);
      visible += inline.visible;
      visibleToMd.push(...inline.visibleToMd);
      searchAt = idx >= 0 ? idx + cell.length : searchAt + cell.length;
    }
    const tag = isFirstRow ? 'th' : 'td';
    rowHtmls.push(
      `<tr>${cellHtmls.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`,
    );
    isFirstRow = false;
    rowStart += rowLine.length + 1;
  }

  const headRow = rowHtmls[0];
  const bodyRows = rowHtmls.slice(1);
  let assembled = '<div class="table-wrap"><table>';
  if (headRow) assembled += `<thead>${headRow}</thead>`;
  if (bodyRows.length) assembled += `<tbody>${bodyRows.join('')}</tbody>`;
  assembled += '</table></div>';
  return wrapMdBlock(assembled, visible, visibleToMd, tableStart);
}

function renderCodeBlockWithMap(
  bodyLines: string[],
  bodyLineStarts: number[],
  blockStart: number,
  lang: string,
  ranges: SourceRange[],
): string {
  let visible = '';
  const visibleToMd: number[] = [];
  let html = `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>`;

  let openRange: SourceRange | undefined;
  let openTag = '';
  const closeSpan = (): void => {
    if (openTag) {
      html += '</span>';
      openTag = '';
      openRange = undefined;
    }
  };
  const pushCodeChar = (ch: string, mdIndex: number): void => {
    const active = rangeAt(ranges, mdIndex);
    if (!sameSpan(openRange, active)) {
      closeSpan();
      if (active) {
        openTag = spanOpenTag(active);
        html += openTag;
        openRange = active;
      }
    }
    visible += ch;
    visibleToMd.push(mdIndex);
    html += escapeHtml(ch);
  };

  for (let li = 0; li < bodyLines.length; li++) {
    const line = bodyLines[li] ?? '';
    const lineStart = bodyLineStarts[li] ?? blockStart;
    for (let c = 0; c < line.length; c++) {
      pushCodeChar(line[c]!, lineStart + c);
    }
    if (li < bodyLines.length - 1) {
      const nlIndex = lineStart + line.length;
      pushCodeChar('\n', nlIndex);
    }
  }
  closeSpan();
  html += '</code></pre>';
  return wrapMdBlock(html, visible, visibleToMd, blockStart);
}

function renderCodeFenceWithMap(
  fenceLines: string[],
  fenceStart: number,
  lineStarts: number[],
  startIndex: number,
  ranges: SourceRange[],
): string {
  const openLine = fenceLines[0] ?? '';
  const lang = openLine.trim().slice(3).trim();
  // 首尾两行是围栏本身，正文只取中间；末行可能因为模型没闭合而不存在
  const bodyLines = fenceLines.slice(1, -1);
  const bodyLineStarts = bodyLines.map((_, li) => lineStarts[startIndex + 1 + li] ?? fenceStart);
  return renderCodeBlockWithMap(bodyLines, bodyLineStarts, fenceStart, lang, ranges);
}

function renderLineBlock(
  line: string,
  lineStart: number,
  ranges: SourceRange[],
  wrapper: (inner: string) => string,
): string {
  const inline = renderInlineMarkdownWithMap(line, lineStart, ranges);
  return wrapMdBlock(wrapper(inline.html), inline.visible, inline.visibleToMd, lineStart);
}

/**
 * 格式化 markdown 并保留 contentMd 偏移映射，供 WebView 划词标注使用。
 * 标注的 selectionStart 对应原始 contentMd，不做 normalizeDisplayText（避免改长度）。
 */
export function markdownToAnnotatedSelectionHtml(
  contentMd: string,
  annotations: Annotation[],
  defaultHighlightColor: string,
): string {
  const ranges = collectAnnotationRanges(contentMd, annotations, defaultHighlightColor);
  const unified = contentMd.replace(/\r\n/g, '\n');
  const lines = unified.split('\n');
  const lineStarts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    lineStarts.push(pos);
    pos += line.length + 1;
  }

  const parts: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const lineStart = lineStarts[index] ?? 0;

    if (line.trim().startsWith('```')) {
      const fenceLines: string[] = [line];
      let end = index + 1;
      while (end < lines.length && !lines[end]!.trim().startsWith('```')) {
        fenceLines.push(lines[end]!);
        end += 1;
      }
      if (end < lines.length) fenceLines.push(lines[end]!);
      parts.push(renderCodeFenceWithMap(fenceLines, lineStart, lineStarts, index, ranges));
      index = end + 1;
      continue;
    }

    if (isMarkdownTableRow(line)) {
      const tableLines: string[] = [];
      const tableStart = lineStart;
      while (index < lines.length && isMarkdownTableRow(lines[index]!)) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      parts.push(renderTableBlockWithMap(tableLines, tableStart, ranges));
      continue;
    }

    const codeEnd = findUnfencedCodeRunEnd(lines, index);
    if (codeEnd !== null) {
      parts.push(
        renderCodeBlockWithMap(
          lines.slice(index, codeEnd),
          lineStarts.slice(index, codeEnd),
          lineStart,
          '',
          ranges,
        ),
      );
      index = codeEnd;
      continue;
    }

    if (!line.trim()) {
      parts.push(wrapMdBlock('<div class="md-blank"></div>', '', [], lineStart));
      index += 1;
      continue;
    }

    const parsed = parseMarkdownLine(line);
    if (parsed.kind === 'plain') {
      parts.push(renderLineBlock(line, lineStart, ranges, (inner) => `<p>${inner}</p>`));
      index += 1;
      continue;
    }

    const inline = renderInlineMarkdownWithMap(
      parsed.text,
      lineStart + parsed.contentStart,
      ranges,
    );
    if (parsed.kind === 'heading') {
      const level = Math.min(parsed.level, 6);
      parts.push(
        wrapMdBlock(
          `<h${level}>${inline.html}</h${level}>`,
          inline.visible,
          inline.visibleToMd,
          lineStart,
        ),
      );
    } else if (parsed.kind === 'quote') {
      parts.push(
        wrapMdBlock(
          `<blockquote>${inline.html}</blockquote>`,
          inline.visible,
          inline.visibleToMd,
          lineStart,
        ),
      );
    } else {
      // 有序号就照原文显示，无序列表换成 •；两者都借原文标记的字符位置做映射，
      // 可见文本和 visibleToMd 必须等长，否则划词偏移会整体错位
      const markerStart = lineStart + line.length - line.trimStart().length;
      const prefix =
        parsed.kind === 'bullet' ? '• ' : line.slice(markerStart - lineStart, parsed.contentStart);
      const prefixMap = Array.from(prefix, (_, i) => markerStart + i);
      parts.push(
        wrapMdBlock(
          `<p>${escapeHtml(prefix)}${inline.html}</p>`,
          `${prefix}${inline.visible}`,
          [...prefixMap, ...inline.visibleToMd],
          lineStart,
        ),
      );
    }
    index += 1;
  }

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

    const codeEnd = findUnfencedCodeRunEnd(lines, index);
    if (codeEnd !== null) {
      parts.push(`<pre><code>${escapeHtml(lines.slice(index, codeEnd).join('\n'))}</code></pre>`);
      index = codeEnd;
      continue;
    }

    if (line.trim()) {
      const parsed = parseMarkdownLine(line);
      const inner = renderInlineMarkdown(parsed.text);
      if (parsed.kind === 'heading') {
        const level = Math.min(parsed.level, 6);
        parts.push(`<h${level}>${inner}</h${level}>`);
      } else if (parsed.kind === 'quote') {
        parts.push(`<blockquote>${inner}</blockquote>`);
      } else if (parsed.kind === 'bullet') {
        parts.push(`<p>• ${inner}</p>`);
      } else if (parsed.kind === 'numbered') {
        const indent = line.length - line.trimStart().length;
        parts.push(`<p>${escapeHtml(line.slice(indent, parsed.contentStart))}${inner}</p>`);
      } else {
        parts.push(`<p>${inner}</p>`);
      }
      index += 1;
      continue;
    }

    parts.push('<div class="md-blank"></div>');
    index += 1;
  }

  return parts.join('');
}
