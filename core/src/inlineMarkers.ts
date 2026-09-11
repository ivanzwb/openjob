export const MARKER_ICON = {
  note: '📝',
  elaboration: '💡',
} as const;

export const MARKER_BADGE = {
  note: '笔',
  elaboration: '细',
} as const;

export const MARKER_LABEL = {
  note: '笔记',
  elaboration: '细化讲解',
} as const;

export type InlineMarkerKind = keyof typeof MARKER_ICON;

export function markerBadgeLabel<T extends { kind: string }>(markers: T[]): string {
  const { hasNote, hasElaboration } = markerKinds(markers);
  if (hasNote && hasElaboration) return `${MARKER_BADGE.note}/${MARKER_BADGE.elaboration}`;
  if (hasNote) return MARKER_BADGE.note;
  if (hasElaboration) return MARKER_BADGE.elaboration;
  return '';
}

function firstLineOf(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

export function resolveInlineAnnotationIndex(
  text: string,
  blockStart: number,
  selectedText: string,
  selectionStart?: number | null,
): { index: number; needle: string } | null {
  const selected = selectedText.trim();
  if (!selected) return null;
  const needle = text.includes(selected) ? selected : firstLineOf(selected);
  if (!needle) return null;
  const anchored = selectionStart != null ? selectionStart - blockStart : undefined;
  const index =
    anchored !== undefined &&
    anchored >= 0 &&
    text.slice(anchored, anchored + needle.length) === needle
      ? anchored
      : text.indexOf(needle);
  return index >= 0 ? { index, needle } : null;
}

export function markerKinds<T extends { kind: string }>(
  markers: T[],
): { hasNote: boolean; hasElaboration: boolean } {
  return {
    hasNote: markers.some((m) => m.kind === 'note'),
    hasElaboration: markers.some((m) => m.kind === 'elaboration'),
  };
}
