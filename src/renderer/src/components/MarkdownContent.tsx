import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { highlightToHtml } from '../lib/highlight';
import { highlightTextStyle } from '../lib/highlightStyle';
import { useUiTheme } from '../lib/uiTheme';
import { visibleMarkdownBlocks } from '../lib/markdownBlocks';
import { parseMarkdownLine, parseMarkdownTextSegments } from '@shared/lib/markdownSegments';
import { parseInlineMarkdown } from '@shared/lib/markdownInline';
import {
  filterInlineAnnotations,
  renderTextWithInlineMarkers,
  type InlineAnnotation,
} from './InlineAnnotationMarkers';
import type { Annotation } from '@shared/entities';

export interface CodeLocation {
  filePath: string;
  startLine: number;
  endLine?: number;
}

export interface TextHighlight {
  text: string;
  color: string;
  start?: number;
  annotationId?: string;
}

interface TextSegment {
  text: string;
  color?: string;
  annotationId?: string;
}

function segmentTextWithHighlights(
  text: string,
  blockStart: number,
  highlights: TextHighlight[],
): TextSegment[] {
  if (!highlights.length) return [{ text }];

  const ranges: Array<{ start: number; end: number; color: string; annotationId?: string }> = [];
  for (const mark of highlights) {
    const needle = mark.text.trim();
    if (!needle) continue;
    if (mark.start !== undefined) {
      // 正文按行、按行内标记切成了多段，跨段的高亮只取与本段的交集
      const start = mark.start - blockStart;
      const from = Math.max(0, start);
      const to = Math.min(text.length, start + needle.length);
      if (to <= from) continue;
      if (text.slice(from, to) !== needle.slice(from - start, to - start)) continue;
      ranges.push({
        start: from,
        end: to,
        color: mark.color,
        ...(mark.annotationId ? { annotationId: mark.annotationId } : {}),
      });
      continue;
    }
    const idx = text.indexOf(needle);
    if (idx === -1) continue;
    ranges.push({
      start: idx,
      end: idx + needle.length,
      color: mark.color,
      ...(mark.annotationId ? { annotationId: mark.annotationId } : {}),
    });
  }

  if (!ranges.length) return [{ text }];

  ranges.sort((a, b) => a.start - b.start);
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) });
    segments.push({ text: text.slice(range.start, range.end), color: range.color, annotationId: range.annotationId });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments.length ? segments : [{ text }];
}

const FILE_REF =
  /(?<![/\w])((?:[\w.-]+\/)+[\w.-]+\.\w+|(?:[\w.-]+\.\w+)):(\d+)(?:-(\d+))?/g;

function renderTextBlock(
  text: string,
  blockStart: number,
  keyPrefix: string,
  onCodeClick?: (loc: CodeLocation) => void,
  highlights?: TextHighlight[],
  inlineAnnotations?: InlineAnnotation[],
  onDeleteAnnotation?: (id: string) => void,
  focusAnnotationId?: string | null,
): React.ReactNode[] {
  const renderPlain = (plain: string, prefix: string): React.ReactNode[] =>
    renderTextWithRefs(plain, blockStart, onCodeClick, highlights, prefix);

  if (inlineAnnotations?.length && onDeleteAnnotation) {
    return renderTextWithInlineMarkers(
      text,
      blockStart,
      inlineAnnotations,
      onDeleteAnnotation,
      renderPlain,
      keyPrefix,
      highlights,
      focusAnnotationId,
    );
  }
  return renderTextWithRefs(text, blockStart, onCodeClick, highlights, keyPrefix);
}

function renderTextWithRefs(
  text: string,
  blockStart: number,
  onCodeClick?: (loc: CodeLocation) => void,
  highlights?: TextHighlight[],
  keyPrefix = 't',
): React.ReactNode[] {
  const segments = highlights?.length
    ? segmentTextWithHighlights(text, blockStart, highlights)
    : [{ text }];
  const nodes: React.ReactNode[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(FILE_REF.source, 'g');

  for (const seg of segments) {
    if (seg.color) {
      nodes.push(
        <mark
          key={`${keyPrefix}-hl-${nodes.length}`}
          className="rounded-sm px-0.5"
          style={highlightTextStyle(seg.color)}
          {...(seg.annotationId ? { 'data-annotation-id': seg.annotationId } : {})}
        >
          {seg.text}
        </mark>,
      );
      continue;
    }

    const segText = seg.text;
    let last = 0;
    while ((match = re.exec(segText)) !== null) {
      if (match.index > last) {
        nodes.push(segText.slice(last, match.index));
      }
      const filePath = match[1]!;
      const startLine = Number(match[2]);
      const endLine = match[3] ? Number(match[3]) : undefined;
      const label = `${filePath}:${startLine}${endLine ? `-${endLine}` : ''}`;
      nodes.push(
        onCodeClick ? (
          <button
            key={`${keyPrefix}-${match.index}-${label}`}
            type="button"
            onClick={() => onCodeClick({ filePath, startLine, endLine })}
            className="font-mono text-emerald-400 hover:underline"
          >
            {label}
          </button>
        ) : (
          <span key={`${keyPrefix}-${match.index}-${label}`} className="font-mono text-emerald-400">
            {label}
          </span>
        ),
      );
      last = match.index + match[0].length;
    }
    if (last < segText.length) nodes.push(segText.slice(last));
  }

  return nodes.length ? nodes : [text];
}

function MermaidBlock({ chart }: { chart: string }): React.JSX.Element {
  const id = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  // mermaid 把配色烧进 SVG，换主题只能重新渲染一次
  const uiTheme = useUiTheme();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        theme: uiTheme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
      });
      if (cancelled || !ref.current) return;
      try {
        const { svg } = await mermaid.render(`mmd-${id}`, chart.trim());
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled && ref.current) {
          ref.current.textContent = chart;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id, uiTheme]);

  return <div ref={ref} className="mb-3 mt-3 overflow-x-auto rounded bg-black/20 p-3 first:mt-0" />;
}

/** shiki 语言别名归一，模型写 `js` / `sh` 也能命中 */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
};

function CodeBlock({ lang, code }: { lang: string | null; code: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const normalized = lang ? (LANG_ALIAS[lang.toLowerCase()] ?? lang.toLowerCase()) : null;
    void highlightToHtml(code, normalized, 1).then((res) => {
      if (!cancelled) setHtml(res);
    });
    return () => {
      cancelled = true;
    };
  }, [lang, code]);

  if (html) {
    return (
      <div
        className="shiki-host mb-3 mt-3 overflow-x-auto rounded bg-black/20 p-3 font-mono text-xs leading-5 first:mt-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="mb-3 mt-3 overflow-x-auto rounded bg-black/20 p-3 font-mono text-xs leading-5 first:mt-0">
      {code}
    </pre>
  );
}

function MarkdownTable({ rows }: { rows: string[][] }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  const colCount = header?.length ?? 0;
  if (colCount === 0) return null;

  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full min-w-[240px] border-collapse text-sm">
        <thead>
          <tr>
            {header!.map((cell, cellIdx) => (
              <th
                key={`h-${cellIdx}`}
                className="border border-[var(--color-border)] bg-black/20 px-2 py-1 text-left font-semibold align-top"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIdx) => (
            <tr key={`r-${rowIdx}`}>
              {row.map((cell, cellIdx) => (
                <td
                  key={`c-${rowIdx}-${cellIdx}`}
                  className="border border-[var(--color-border)] px-2 py-1 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-4 text-base font-semibold first:mt-0',
  2: 'mt-3 text-[0.95rem] font-semibold first:mt-0',
  3: 'mt-3 text-sm font-semibold first:mt-0',
};

interface InlineRenderProps {
  onCodeClick?: (loc: CodeLocation) => void;
  highlights?: TextHighlight[];
  inlineAnnotations?: InlineAnnotation[];
  onDeleteAnnotation?: (id: string) => void;
  focusAnnotationId?: string | null;
}

/**
 * 行内标记逐个包成独立元素，并各自带上 data-md-start。
 *
 * 划词标注是把 DOM 内的字符偏移加到最近的 data-md-start 上还原成 contentMd
 * 偏移的（见 lib/selectionOffset）。渲染 markdown 会吃掉 ** ` 这些标记字符，
 * 整段只挂一个起点就会越算越偏；锚点下沉到每个 token，token 内的文本与原文
 * 逐字相同，偏移才重新对得上。
 */
function renderInlineTokens(
  source: string,
  sourceStart: number,
  keyPrefix: string,
  props: InlineRenderProps,
): React.ReactNode[] {
  return parseInlineMarkdown(source, sourceStart).map((token, i) => {
    const key = `${keyPrefix}-i${i}`;
    const inner = renderTextBlock(
      token.text,
      token.start,
      key,
      props.onCodeClick,
      props.highlights,
      props.inlineAnnotations,
      props.onDeleteAnnotation,
      props.focusAnnotationId,
    );
    const anchor = { 'data-md-start': token.start };

    if (token.kind === 'bold') {
      return (
        <strong key={key} className="font-semibold" {...anchor}>
          {inner}
        </strong>
      );
    }
    if (token.kind === 'italic') {
      return (
        <em key={key} className="italic" {...anchor}>
          {inner}
        </em>
      );
    }
    if (token.kind === 'code') {
      return (
        <code
          key={key}
          className="rounded bg-black/20 px-1 py-0.5 font-mono text-[0.9em] text-emerald-300"
          {...anchor}
        >
          {inner}
        </code>
      );
    }
    if (token.kind === 'link') {
      return (
        <a
          key={key}
          href={token.href}
          target="_blank"
          rel="noreferrer"
          className="text-sky-400 hover:underline"
          {...anchor}
        >
          {inner}
        </a>
      );
    }
    return (
      <span key={key} {...anchor}>
        {inner}
      </span>
    );
  });
}

function MarkdownProseLine({
  line,
  lineStart,
  keyPrefix,
  props,
}: {
  line: string;
  lineStart: number;
  keyPrefix: string;
  props: InlineRenderProps;
}): React.JSX.Element | null {
  if (!line.trim()) return null;

  const parsed = parseMarkdownLine(line);
  const content = renderInlineTokens(
    parsed.text,
    lineStart + parsed.contentStart,
    keyPrefix,
    props,
  );

  if (parsed.kind === 'heading') {
    return <div className={HEADING_CLASS[Math.min(parsed.level, 3)]}>{content}</div>;
  }

  if (parsed.kind === 'quote') {
    return (
      <div className="border-l-2 border-[var(--color-border)] pl-2 text-[var(--color-muted)]">
        {content}
      </div>
    );
  }

  if (parsed.kind === 'bullet' || parsed.kind === 'numbered') {
    // 项目符号不在正文里，标成 annotation-ui 让划词偏移跳过它
    const marker = parsed.kind === 'bullet' ? '•' : line.trimStart().split(/\s/)[0];
    return (
      <div className="flex gap-1.5">
        <span data-annotation-ui className="shrink-0 select-none text-[var(--color-muted)]">
          {marker}
        </span>
        <span className="min-w-0 flex-1">{content}</span>
      </div>
    );
  }

  return <div>{content}</div>;
}

/** 每行在 contentMd 里的起点，换行符算一个字符 */
function lineOffsets(lines: string[], blockStart: number): number[] {
  const offsets: number[] = [];
  let pos = blockStart;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1;
  }
  return offsets;
}

function MarkdownProse({
  lines,
  blockStart,
  keyPrefix,
  props,
}: {
  lines: string[];
  blockStart: number;
  keyPrefix: string;
  props: InlineRenderProps;
}): React.JSX.Element {
  const offsets = lineOffsets(lines, blockStart);
  const lastIdx = lines.length - 1;
  const blockEnd = lastIdx >= 0 ? offsets[lastIdx]! + lines[lastIdx]!.length : blockStart;

  return (
    <div className="space-y-1 break-words" data-md-start={blockStart} data-md-end={blockEnd}>
      {lines.map((line, lineIdx) => (
        <MarkdownProseLine
          key={`${keyPrefix}-l${lineIdx}`}
          line={line}
          lineStart={offsets[lineIdx]!}
          keyPrefix={`${keyPrefix}-l${lineIdx}`}
          props={props}
        />
      ))}
    </div>
  );
}

function MarkdownTextPart({
  value,
  mdStart,
  keyPrefix,
  onCodeClick,
  highlights,
  inlineAnnotations,
  onDeleteAnnotation,
  focusAnnotationId,
}: {
  value: string;
  mdStart: number;
  keyPrefix: string;
  onCodeClick?: (loc: CodeLocation) => void;
  highlights?: TextHighlight[];
  inlineAnnotations?: InlineAnnotation[];
  onDeleteAnnotation?: (id: string) => void;
  focusAnnotationId?: string | null;
}): React.JSX.Element {
  const segments = parseMarkdownTextSegments(value);
  const props: InlineRenderProps = {
    ...(onCodeClick ? { onCodeClick } : {}),
    ...(highlights ? { highlights } : {}),
    ...(inlineAnnotations ? { inlineAnnotations } : {}),
    ...(onDeleteAnnotation ? { onDeleteAnnotation } : {}),
    ...(focusAnnotationId !== undefined ? { focusAnnotationId } : {}),
  };

  return (
    <>
      {segments.map((segment, segIdx) => {
        if (segment.type === 'table') {
          return <MarkdownTable key={`${keyPrefix}-table-${segIdx}`} rows={segment.rows} />;
        }
        if (segment.type === 'code') {
          // 模型漏了围栏，语言也就无从得知，交给 shiki 的纯文本分支
          return (
            <CodeBlock
              key={`${keyPrefix}-code-${segIdx}`}
              lang={null}
              code={segment.lines.join('\n')}
            />
          );
        }
        const segmentText = segment.lines.join('\n');
        const localStart = value.indexOf(segmentText);
        return (
          <MarkdownProse
            key={`${keyPrefix}-para-${segIdx}`}
            lines={segment.lines}
            blockStart={mdStart + (localStart >= 0 ? localStart : 0)}
            keyPrefix={`${keyPrefix}-${segIdx}`}
            props={props}
          />
        );
      })}
    </>
  );
}

export function MarkdownContent({
  text,
  onCodeClick,
  highlights,
  annotations,
  onDeleteAnnotation,
  focusAnnotationId,
}: {
  text: string;
  onCodeClick?: (loc: CodeLocation) => void;
  highlights?: TextHighlight[];
  annotations?: Annotation[];
  onDeleteAnnotation?: (id: string) => void;
  focusAnnotationId?: string | null;
}): React.JSX.Element {
  const inlineAnnotations = useMemo(
    () => (annotations ? filterInlineAnnotations(annotations) : []),
    [annotations],
  );

  const parts = useMemo(() => visibleMarkdownBlocks(text), [text]);

  if (parts.length === 0) return <></>;

  return (
    <div className="space-y-1 text-sm leading-relaxed [&>*:first-child]:mt-0">
      {parts.map((part, i) => {
        if (part.type === 'mermaid') return <MermaidBlock key={`m-${i}`} chart={part.value} />;
        if (part.type === 'code') {
          return <CodeBlock key={`c-${i}`} lang={part.lang ?? null} code={part.value} />;
        }
        return (
          <MarkdownTextPart
            key={`t-${i}`}
            value={part.value}
            mdStart={part.mdStart}
            keyPrefix={`t-${i}`}
            onCodeClick={onCodeClick}
            highlights={highlights}
            inlineAnnotations={inlineAnnotations}
            onDeleteAnnotation={onDeleteAnnotation}
            focusAnnotationId={focusAnnotationId}
          />
        );
      })}
    </div>
  );
}
