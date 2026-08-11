import { useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation } from '@shared/entities';
import { annotationMarkSummary, sortMarksByContentPosition } from '@shared/annotationMarkList';

const toolbarBtn =
  'rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-black/20 hover:text-[var(--color-fg)]';

export function AnnotationMarkMenu({
  marks,
  contentMd,
  onSelect,
}: {
  marks: Annotation[];
  contentMd: string;
  onSelect: (id: string) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sorted = useMemo(
    () => sortMarksByContentPosition(marks, contentMd),
    [marks, contentMd],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!marks.length) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${toolbarBtn} text-[10px] text-sky-300 hover:text-sky-200`}
        title="查看并定位标记"
      >
        {marks.length} 条标记
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-xl">
          {sorted.map((mark) => (
            <button
              key={mark.id}
              type="button"
              onClick={() => {
                onSelect(mark.id);
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-xs text-[var(--color-fg)] hover:bg-black/20"
            >
              {annotationMarkSummary(mark)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
