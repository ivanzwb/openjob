import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Annotation } from '@shared/entities';
import { highlightTextStyle } from '../lib/highlightStyle';
import { useAdaptivePopover } from '../lib/popoverLayout';
import { MarkdownContent, type TextHighlight } from './MarkdownContent';

export type InlineAnnotation = Pick<Annotation, 'id' | 'kind' | 'selectedText' | 'noteMd'>;

const MARKER_LABEL: Record<'note' | 'elaboration', string> = {
  note: '笔记',
  elaboration: '细化讲解',
};

function markerKinds(markers: InlineAnnotation[]): {
  hasNote: boolean;
  hasElaboration: boolean;
} {
  return {
    hasNote: markers.some((m) => m.kind === 'note'),
    hasElaboration: markers.some((m) => m.kind === 'elaboration'),
  };
}

function markerTextClass(markers: InlineAnnotation[]): string {
  const { hasNote, hasElaboration } = markerKinds(markers);
  if (hasNote && hasElaboration) {
    return 'font-bold text-amber-300 underline decoration-sky-400 decoration-2 decoration-dashed underline-offset-2';
  }
  if (hasNote) {
    return 'font-bold text-amber-300 border-b-2 border-amber-400/90';
  }
  return 'font-bold text-sky-300 border-b-2 border-dashed border-sky-400/90';
}

function markerTitle(markers: InlineAnnotation[]): string {
  const { hasNote, hasElaboration } = markerKinds(markers);
  if (hasNote && hasElaboration) return '查看笔记 / 细化讲解';
  if (hasNote) return '查看笔记';
  return '查看细化讲解';
}

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
  const popoverStyle = useAdaptivePopover(ref, anchorRect, true, [marker.noteMd, marker.selectedText]);

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

  const kind = marker.kind as 'note' | 'elaboration';

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[110] min-w-48 max-w-[calc(100vw-16px)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
      style={popoverStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[10px] font-medium text-[var(--color-muted)]">{MARKER_LABEL[kind]}</p>
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
      <div className="break-words text-xs leading-relaxed [overflow-wrap:anywhere] [&_.shiki-host]:overflow-x-hidden [&_pre]:whitespace-pre-wrap">
        <MarkdownContent text={marker.noteMd ?? ''} />
      </div>
    </div>,
    document.body,
  );
}

function MarkerPickMenu({
  markers,
  anchorRect,
  onSelect,
  onClose,
}: {
  markers: InlineAnnotation[];
  anchorRect: DOMRect;
  onSelect: (marker: InlineAnnotation) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

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

  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 120);
  const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - 160);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[110] flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-xl"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {markers.map((m) => {
        const kind = m.kind as 'note' | 'elaboration';
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m)}
            className={`whitespace-nowrap rounded px-2 py-1 text-left text-xs hover:bg-black/20 ${
              kind === 'note' ? 'font-bold text-amber-300' : 'font-bold text-sky-300'
            }`}
          >
            {MARKER_LABEL[kind]}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function InlineMarkedText({
  text,
  markers,
  highlight,
  onDelete,
}: {
  text: string;
  markers: InlineAnnotation[];
  highlight?: TextHighlight;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [activeMarker, setActiveMarker] = useState<InlineAnnotation | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const open = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchorRect(rect);
    if (markers.length === 1) {
      setActiveMarker(markers[0]!);
      setShowPicker(false);
      return;
    }
    setActiveMarker(null);
    setShowPicker(true);
  }, [markers]);

  const close = useCallback(() => {
    setActiveMarker(null);
    setShowPicker(false);
    setAnchorRect(null);
  }, []);

  const textClass = `cursor-pointer rounded-sm px-0.5 transition-opacity hover:opacity-90 ${markerTextClass(markers)}`;
  const inner = highlight ? (
    <mark className={textClass} style={highlightTextStyle(highlight.color)}>
      {text}
    </mark>
  ) : (
    <span className={textClass}>{text}</span>
  );

  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        title={markerTitle(markers)}
        className="inline"
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
      >
        {inner}
      </span>
      {showPicker && anchorRect && (
        <MarkerPickMenu
          markers={markers}
          anchorRect={anchorRect}
          onSelect={(marker) => {
            setShowPicker(false);
            setActiveMarker(marker);
          }}
          onClose={close}
        />
      )}
      {activeMarker && anchorRect && (
        <InlineMarkerPopover
          marker={activeMarker}
          anchorRect={anchorRect}
          onClose={close}
          onDelete={(id) => {
            onDelete(id);
            close();
          }}
        />
      )}
    </>
  );
}

type TextSegment =
  | { type: 'plain'; text: string }
  | { type: 'marked'; text: string; start: number; end: number; markers: InlineAnnotation[] };

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
    segments.push({
      type: 'marked',
      text: text.slice(m.start, m.end),
      start: m.start,
      end: m.end,
      markers: m.markers,
    });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ type: 'plain', text: text.slice(cursor) });

  return segments;
}

function findHighlightForSegment(
  blockStart: number,
  segStart: number,
  segText: string,
  highlights?: TextHighlight[],
): TextHighlight | undefined {
  const trimmed = segText.trim();
  if (!trimmed || !highlights?.length) return undefined;
  const absStart = blockStart + segStart;
  const exact = highlights.find((h) => h.start === absStart && h.text.trim() === trimmed);
  if (exact) return exact;
  return highlights.find((h) => h.start === undefined && h.text.trim() === trimmed);
}

export function renderTextWithInlineMarkers(
  text: string,
  blockStart: number,
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
    const hl = findHighlightForSegment(blockStart, seg.start, seg.text, highlights);
    nodes.push(
      <InlineMarkedText
        key={segKey}
        text={seg.text}
        markers={seg.markers}
        {...(hl ? { highlight: hl } : {})}
        onDelete={onDelete}
      />,
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
