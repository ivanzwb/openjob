import type { Annotation } from '@shared/entities';
import { findMarkOnSelection } from '@shared/annotationMarkList';

export const HIGHLIGHT_COLORS = [
  '#fef08a',
  '#fda4af',
  '#7dd3fc',
  '#a7f3d0',
  '#c4b5fd',
  '#fdba74',
] as const;

export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0];

export type InlineAnnotation = Pick<Annotation, 'id' | 'kind' | 'selectedText' | 'noteMd'>;

export interface TextHighlight {
  text: string;
  color: string;
  start?: number;
}

export function findHighlightMark(
  text: string,
  marks: Annotation[],
  selectionStart?: number,
): Annotation | undefined {
  return findMarkOnSelection(marks, 'highlight', text, selectionStart);
}

export function phraseSelectionStart(contentMd: string, phrase: string): number | undefined {
  const trimmed = phrase.trim();
  if (!trimmed) return undefined;
  const idx = contentMd.indexOf(trimmed);
  return idx >= 0 ? idx : undefined;
}

type PlainSegment = { kind: 'plain'; text: string; start: number };
type HighlightSegment = { kind: 'highlight'; text: string; start: number; color: string };
type MarkedSegment = {
  kind: 'marked';
  text: string;
  start: number;
  end: number;
  markers: InlineAnnotation[];
  highlightColor?: string;
};

export type DisplaySegment = PlainSegment | HighlightSegment | MarkedSegment;

function segmentTextWithHighlights(
  text: string,
  blockStart: number,
  highlights: TextHighlight[],
): { text: string; start: number; color?: string }[] {
  if (!highlights.length) return [{ text, start: blockStart }];

  const ranges: { start: number; end: number; color: string }[] = [];
  for (const mark of highlights) {
    const needle = mark.text.trim();
    if (!needle) continue;
    if (mark.start !== undefined) {
      const start = mark.start - blockStart;
      const end = start + needle.length;
      if (start < 0 || end > text.length) continue;
      if (text.slice(start, end) !== needle) continue;
      ranges.push({ start, end, color: mark.color });
      continue;
    }
    const idx = text.indexOf(needle);
    if (idx === -1) continue;
    ranges.push({ start: idx, end: idx + needle.length, color: mark.color });
  }

  if (!ranges.length) return [{ text, start: blockStart }];

  ranges.sort((a, b) => a.start - b.start);
  const segments: { text: string; start: number; color?: string }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), start: blockStart + cursor });
    }
    segments.push({
      text: text.slice(range.start, range.end),
      start: blockStart + range.start,
      color: range.color,
    });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), start: blockStart + cursor });
  }
  return segments.length ? segments : [{ text, start: blockStart }];
}

type InlineSplit =
  | { type: 'plain'; text: string; start: number }
  | { type: 'marked'; text: string; start: number; end: number; markers: InlineAnnotation[] };

function splitByInlineAnnotations(
  text: string,
  blockStart: number,
  annotations: InlineAnnotation[],
): InlineSplit[] {
  if (!annotations.length) return [{ type: 'plain', text, start: blockStart }];

  const matches: { start: number; end: number; markers: InlineAnnotation[] }[] = [];
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

  if (!matches.length) return [{ type: 'plain', text, start: blockStart }];

  matches.sort((a, b) => a.start - b.start);
  const segments: InlineSplit[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) {
      segments.push({ type: 'plain', text: text.slice(cursor, m.start), start: blockStart + cursor });
    }
    segments.push({
      type: 'marked',
      text: text.slice(m.start, m.end),
      start: blockStart + m.start,
      end: blockStart + m.end,
      markers: m.markers,
    });
    cursor = m.end;
  }
  if (cursor < text.length) {
    segments.push({ type: 'plain', text: text.slice(cursor), start: blockStart + cursor });
  }
  return segments;
}

function findHighlightForRange(
  absStart: number,
  text: string,
  highlights: TextHighlight[],
): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || !highlights.length) return undefined;
  const exact = highlights.find((h) => h.start === absStart && h.text.trim() === trimmed);
  if (exact) return exact.color;
  const loose = highlights.find((h) => h.start === undefined && h.text.trim() === trimmed);
  return loose?.color;
}

export function buildDisplaySegments(
  contentMd: string,
  highlights: TextHighlight[],
  inlineAnnotations: InlineAnnotation[],
): DisplaySegment[] {
  const blockStart = 0;
  const raw = splitByInlineAnnotations(contentMd, blockStart, inlineAnnotations);
  const out: DisplaySegment[] = [];

  for (const seg of raw) {
    if (seg.type === 'marked') {
      const hlColor = findHighlightForRange(seg.start, seg.text, highlights);
      out.push({
        kind: 'marked',
        text: seg.text,
        start: seg.start,
        end: seg.end,
        markers: seg.markers,
        ...(hlColor ? { highlightColor: hlColor } : {}),
      });
      continue;
    }
    const sub = segmentTextWithHighlights(seg.text, seg.start, highlights);
    for (const s of sub) {
      if (s.color) {
        out.push({ kind: 'highlight', text: s.text, start: s.start, color: s.color });
      } else {
        out.push({ kind: 'plain', text: s.text, start: s.start });
      }
    }
  }

  return out.length ? out : [{ kind: 'plain', text: contentMd, start: 0 }];
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
