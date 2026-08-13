import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { highlightToHtml } from '../lib/highlight';
import { highlightTextStyle } from '../lib/highlightStyle';
import { visibleMarkdownBlocks } from '../lib/markdownBlocks';
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
      const start = mark.start - blockStart;
      const end = start + needle.length;
      if (start < 0 || end > text.length) continue;
      if (text.slice(start, end) !== needle) continue;
      ranges.push({
        start,
        end,
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
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
  }, [chart, id]);

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
          <div
            key={`t-${i}`}
            className="whitespace-pre-wrap"
            data-md-start={part.mdStart}
            data-md-end={part.mdEnd}
          >
            {renderTextBlock(
              part.value,
              part.mdStart,
              `t-${i}`,
              onCodeClick,
              highlights,
              inlineAnnotations,
              onDeleteAnnotation,
              focusAnnotationId,
            )}
          </div>
        );
      })}
    </div>
  );
}
