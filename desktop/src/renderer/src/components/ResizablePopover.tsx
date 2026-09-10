import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';

const MARGIN = 8;

export type ResizablePanelPreset = 'edit' | 'note' | 'highlight' | 'view' | 'regenerate';

export interface PanelSize {
  width: number;
  height: number;
}

const PRESETS: Record<
  ResizablePanelPreset,
  { defaultSize: PanelSize; minSize: PanelSize }
> = {
  edit: {
    defaultSize: { width: 440, height: 300 },
    minSize: { width: 320, height: 220 },
  },
  note: {
    defaultSize: { width: 380, height: 260 },
    minSize: { width: 300, height: 200 },
  },
  highlight: {
    defaultSize: { width: 300, height: 180 },
    minSize: { width: 260, height: 140 },
  },
  view: {
    defaultSize: { width: 420, height: 280 },
    minSize: { width: 320, height: 200 },
  },
  regenerate: {
    defaultSize: { width: 420, height: 250 },
    minSize: { width: 320, height: 200 },
  },
};

function clampSize(size: PanelSize, min: PanelSize): PanelSize {
  const maxW = window.innerWidth - MARGIN * 2;
  const maxH = window.innerHeight - MARGIN * 2;
  return {
    width: Math.min(maxW, Math.max(min.width, size.width)),
    height: Math.min(maxH, Math.max(min.height, size.height)),
  };
}

export function useResizablePanel(preset: ResizablePanelPreset): {
  size: PanelSize;
  resizeHandleProps: {
    onPointerDown: (e: ReactPointerEvent) => void;
    title: string;
    className: string;
  };
} {
  const { defaultSize, minSize } = PRESETS[preset];
  const [size, setSize] = useState<PanelSize>(() => clampSize(defaultSize, minSize));

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const startW = size.width;
      const startH = size.height;

      const onMove = (ev: PointerEvent): void => {
        const next = clampSize(
          {
            width: startW + (ev.clientX - startX),
            height: startH + (ev.clientY - startY),
          },
          minSize,
        );
        setSize(next);
      };

      const onUp = (ev: PointerEvent): void => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [minSize, size.height, size.width],
  );

  return {
    size,
    resizeHandleProps: {
      onPointerDown: onResizePointerDown,
      title: '拖动调整大小',
      className:
        'absolute bottom-0 right-0 z-10 h-4 w-4 cursor-se-resize touch-none text-[var(--color-muted)] hover:text-[var(--color-fg)]',
    },
  };
}

export function ResizeHandleGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
      <path
        d="M11 1v10H1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M11 5v6H5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
