export const MARKER_ICON = {
  note: '📝',
  elaboration: '💡',
} as const;

export const MARKER_LABEL = {
  note: '笔记',
  elaboration: '细化讲解',
} as const;

export type InlineMarkerKind = keyof typeof MARKER_ICON;

export function markerKinds<T extends { kind: string }>(
  markers: T[],
): { hasNote: boolean; hasElaboration: boolean } {
  return {
    hasNote: markers.some((m) => m.kind === 'note'),
    hasElaboration: markers.some((m) => m.kind === 'elaboration'),
  };
}
