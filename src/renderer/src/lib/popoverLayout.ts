import { useLayoutEffect, useState, type RefObject } from 'react';

const MARGIN = 8;
const MIN_WIDTH = 192;

export type PopoverAnchor =
  | { top: number; left: number; width?: number; center?: boolean }
  | DOMRect;

function resolveAnchor(anchor: PopoverAnchor, center: boolean): {
  top: number;
  left: number;
  width: number;
  center: boolean;
} {
  if (anchor instanceof DOMRect) {
    return {
      top: anchor.bottom + 6,
      left: anchor.left,
      width: anchor.width,
      center,
    };
  }
  return {
    top: anchor.top,
    left: anchor.left,
    width: anchor.width ?? 0,
    center: anchor.center ?? center,
  };
}

function anchorKey(anchor: PopoverAnchor | null): string {
  if (!anchor) return '';
  if (anchor instanceof DOMRect) {
    return `rect:${anchor.top},${anchor.left},${anchor.bottom},${anchor.right}`;
  }
  return `pt:${anchor.top},${anchor.left},${anchor.width ?? 0}`;
}

function styleEqual(a: React.CSSProperties, b: React.CSSProperties): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key as keyof React.CSSProperties] !== b[key as keyof React.CSSProperties]) {
      return false;
    }
  }
  return true;
}

/** Measure popover size from content and clamp position within the viewport. */
export function useAdaptivePopover(
  ref: RefObject<HTMLElement | null>,
  anchor: PopoverAnchor | null,
  enabled: boolean,
  options?: { center?: boolean; remeasureKey?: string },
): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const center = options?.center ?? false;
  const remeasureKey = options?.remeasureKey ?? '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor || !enabled) return;

    const maxW = window.innerWidth - MARGIN * 2;
    const maxH = window.innerHeight - MARGIN * 2;

    el.style.width = 'max-content';
    el.style.maxWidth = `${maxW}px`;
    el.style.removeProperty('height');
    el.style.removeProperty('max-height');
    el.style.overflow = 'hidden';

    const naturalWidth = Math.min(Math.max(el.scrollWidth, MIN_WIDTH), maxW);
    el.style.width = `${naturalWidth}px`;

    const contentHeight = el.scrollHeight;
    const needsScroll = contentHeight > maxH;
    const height = needsScroll ? maxH : contentHeight;

    const point = resolveAnchor(anchor, center);
    let left = point.center ? point.left - naturalWidth / 2 : point.left;
    let top = point.top;

    if (top + height > window.innerHeight - MARGIN) {
      const flippedTop = point.top - 6 - height;
      top = flippedTop >= MARGIN ? flippedTop : Math.max(MARGIN, window.innerHeight - MARGIN - height);
    }

    left = Math.min(Math.max(MARGIN, left), window.innerWidth - MARGIN - naturalWidth);
    top = Math.min(Math.max(MARGIN, top), window.innerHeight - MARGIN - (needsScroll ? maxH : height));

    el.style.removeProperty('width');
    el.style.removeProperty('height');
    el.style.removeProperty('max-height');
    el.style.removeProperty('overflow');

    const nextStyle: React.CSSProperties = {
      top,
      left,
      width: naturalWidth,
      overflowX: 'hidden',
      ...(needsScroll
        ? { maxHeight: maxH, overflowY: 'auto' as const }
        : { overflowY: 'hidden' as const }),
    };

    setStyle((prev) => (styleEqual(prev, nextStyle) ? prev : nextStyle));
  }, [ref, enabled, center, anchorKey(anchor), remeasureKey]);

  return style;
}

export function syncTextareaHeight(
  el: HTMLTextAreaElement | null,
  minRows = 3,
): void {
  if (!el) return;
  const style = getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  const padding =
    Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const minHeight = lineHeight * minRows + padding;
  const maxHeight = Math.floor(window.innerHeight * 0.55);

  el.style.height = 'auto';
  const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  el.style.overflowX = 'hidden';
}
