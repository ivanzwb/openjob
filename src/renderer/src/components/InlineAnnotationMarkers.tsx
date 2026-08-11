import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Annotation } from '@shared/entities';
import { highlightTextStyle } from '../lib/highlightStyle';
import { MarkdownContent, type TextHighlight } from './MarkdownContent';

export type InlineAnnotation = Pick<Annotation, 'id' | 'kind' | 'selectedText' | 'noteMd'>;

const MARKER_ICON: Record<'note' | 'elaboration', string> = {
  note: '📝',
  elaboration: '💡',
};

const MARKER_LABEL: Record<'note' | 'elaboration', string> = {
  note: '笔记',
  elaboration: '细化讲解',
};

const MARKER_TONE: Record<'note' | 'elaboration', string> = {
  note: 'text-amber-300 hover:bg-amber-500/20',
  elaboration: 'text-sky-300 hover:bg-sky-500/20',
};

function InlineMarkerPopover({
  marker,
  anchorRect,
  onClose,
  onDelete,
}: {
  marker: InlineAnnotation;
  anchorRect: DOMRect;
  onClose: () => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const kind = marker.kind as 'note' | 'elaboration';

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 280);
  const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - 320);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[110] w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[10px] font-medium text-[var(--color-muted)]">
          {MARKER_ICON[kind]} {MARKER_LABEL[kind]}
        </p>
        <button
          type="button"
          onClick={() => onDelete(marker.id)}
          className="shrink-0 text-[10px] text-[var(--color-muted)] hover:text-red-400"
        >
          删除
        </button>
      </div>
      {marker.selectedText && (
        <p className="mb-2 line-clamp-2 text-[10px] text-[var(--color-muted)]">
          「{marker.selectedText}」
        </p>
      )}
      <div className="max-h-48 overflow-y-auto text-xs leading-relaxed">
        <MarkdownContent text={marker.noteMd ?? ''} />
      </div>
    </div>,
    document.body,
  );
}

function InlineMarkerButton({
  marker,
  onDelete,
}: {
  marker: InlineAnnotation;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const kind = marker.kind as 'note' | 'elaboration';

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchorRect(rect);
    setOpen(true);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className={`mx-0.5 inline-flex h-4 w-4 items-center justify-center rounded align-super text-[10px] leading-none ${MARKER_TONE[kind]}`}
        title={MARKER_LABEL[kind]}
      >
        {MARKER_ICON[kind]}
      </button>
      {open && anchorRect && (
        <InlineMarkerPopover
          marker={marker}
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          onDelete={(id) => {
            onDelete(id);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

type TextSegment =
  | { type: 'plain'; text: string }
  | { type: 'marked'; text: string; markers: InlineAnnotation[] };

function splitByInlineAnnotations(
  text: string,
  annotations: InlineAnnotation[],
): TextSegment[] {
  if (!annotations.length) return [{ type: 'plain', text }];

  const matches: Array<{ start: number; end: number; markers: InlineAnnotation[] }> = [];

  for (const ann of annotations) {
    const sel = ann.selectedText?.trim();
    if (!sel) continue;
    const idx = text.indexOf(sel);
    if (idx < 0) continue;
    const end = idx + sel.length;
    const existing = matches.find((m) => m.start === idx && m.end === end);
    if (existing) {
      existing.markers.push(ann);
    } else {
      const overlaps = matches.some((m) => !(end <= m.start || idx >= m.end));
      if (!overlaps) matches.push({ start: idx, end, markers: [ann] });
    }
  }

  if (!matches.length) return [{ type: 'plain', text }];

  matches.sort((a, b) => a.start - b.start);
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const m of matches) {
    if (m.start > cursor) segments.push({ type: 'plain', text: text.slice(cursor, m.start) });
    segments.push({ type: 'marked', text: text.slice(m.start, m.end), markers: m.markers });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ type: 'plain', text: text.slice(cursor) });

  return segments;
}

function findHighlightForText(text: string, highlights?: TextHighlight[]): TextHighlight | undefined {
  const trimmed = text.trim();
  if (!trimmed || !highlights?.length) return undefined;
  return highlights.find((h) => h.text.trim() === trimmed);
}

export function renderTextWithInlineMarkers(
  text: string,
  annotations: InlineAnnotation[],
  onDelete: (id: string) => void,
  renderPlain: (plain: string, keyPrefix: string) => React.ReactNode[],
  keyPrefix: string,
  highlights?: TextHighlight[],
): React.ReactNode[] {
  const segments = splitByInlineAnnotations(text, annotations);
  const nodes: React.ReactNode[] = [];

  segments.forEach((seg, i) => {
    const segKey = `${keyPrefix}-seg-${i}`;
    if (seg.type === 'plain') {
      nodes.push(...renderPlain(seg.text, segKey));
      return;
    }
    const hl = findHighlightForText(seg.text, highlights);
    nodes.push(
      <span key={segKey} className="inline">
        {hl ? (
          <mark className="rounded-sm px-0.5" style={highlightTextStyle(hl.color)}>
            {seg.text}
          </mark>
        ) : (
          <span className="rounded-sm bg-[var(--color-accent)]/10">{seg.text}</span>
        )}
        {seg.markers.map((m) => (
          <InlineMarkerButton key={m.id} marker={m} onDelete={onDelete} />
        ))}
      </span>,
    );
  });

  return nodes.length ? nodes : renderPlain(text, keyPrefix);
}

export function filterInlineAnnotations(annotations: Annotation[]): InlineAnnotation[] {
  return annotations
    .filter((a) => (a.kind === 'note' || a.kind === 'elaboration') && Boolean(a.noteMd?.trim()))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      selectedText: a.selectedText,
      noteMd: a.noteMd,
    }));
}
