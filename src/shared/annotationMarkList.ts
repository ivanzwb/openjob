import type { Annotation } from './entities';

export type ContentMark = Pick<Annotation, 'id' | 'kind' | 'selectedText' | 'noteMd' | 'selectionStart' | 'createdAt'>;

const MARK_KIND_LABEL: Record<'highlight' | 'note' | 'elaboration', string> = {
  highlight: '高亮',
  note: '笔记',
  elaboration: '细化讲解',
};

export type SelectionMarkKind = 'highlight' | 'note' | 'elaboration';

/**
 * 找出同一段选区上已有的某类标记，两端与主进程共用同一套「同一段」判定。
 *
 * 选区身份是「文本 + 位置」：位置能对上优先按位置，只有文本对得上时退而认它
 * （老数据没记 selectionStart），这样同一句话在正文里出现两次也能分开处理。
 */
export function findMarkOnSelection<
  T extends Pick<Annotation, 'kind' | 'selectedText' | 'selectionStart'>,
>(marks: T[], kind: SelectionMarkKind, text: string, selectionStart?: number): T | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const matches = marks.filter((m) => m.kind === kind && m.selectedText?.trim() === trimmed);
  if (!matches.length) return undefined;
  if (selectionStart !== undefined) {
    const exact = matches.find((m) => m.selectionStart === selectionStart);
    if (exact) return exact;
  }
  return matches.find((m) => m.selectionStart == null) ?? matches[0];
}

export function annotationContentOffset(
  mark: Pick<Annotation, 'selectedText' | 'selectionStart' | 'noteMd'>,
  contentMd: string,
): number {
  if (mark.selectionStart != null) return mark.selectionStart;
  const text = mark.selectedText?.trim();
  if (text) {
    const idx = contentMd.indexOf(text);
    if (idx >= 0) return idx;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function annotationMarkSummary(
  mark: Pick<Annotation, 'kind' | 'selectedText' | 'noteMd'>,
): string {
  const kind = MARK_KIND_LABEL[mark.kind as keyof typeof MARK_KIND_LABEL] ?? mark.kind;
  const raw = mark.selectedText?.trim() || mark.noteMd?.trim() || '…';
  const clipped = raw.length > 22 ? `${raw.slice(0, 22)}…` : raw;
  return `${kind} · 「${clipped}」`;
}

export function sortMarksByContentPosition<T extends Pick<Annotation, 'selectedText' | 'selectionStart' | 'noteMd' | 'createdAt'>>(
  marks: T[],
  contentMd: string,
): T[] {
  return [...marks].sort((a, b) => {
    const posA = annotationContentOffset(a, contentMd);
    const posB = annotationContentOffset(b, contentMd);
    if (posA !== posB) return posA - posB;
    return a.createdAt - b.createdAt;
  });
}

export function filterContentMarks(annotations: Annotation[]): ContentMark[] {
  return annotations.filter(
    (a) => a.kind === 'highlight' || a.kind === 'note' || a.kind === 'elaboration',
  );
}
