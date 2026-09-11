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
  options?: {
    center?: boolean;
    remeasureKey?: string;
    resizable?: boolean;
    panelSize?: { width: number; height: number };
  },
): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const center = options?.center ?? false;
  const remeasureKey = options?.remeasureKey ?? '';
  const resizable = options?.resizable ?? false;

  // 锚点每次渲染都是新的 DOMRect（或新字面量对象），面板尺寸同理：
  // 直接进依赖数组会让布局 effect 每帧重跑。渲染期先拍成几个数字，
  // effect 只依赖这些值，位置真的变了才重新定位。
  const point = anchor ? resolveAnchor(anchor, center) : null;
  const hasAnchor = point !== null;
  const anchorTop = point?.top ?? 0;
  const anchorLeft = point?.left ?? 0;
  const anchorCentered = point?.center ?? false;
  const panelWidth = options?.panelSize?.width;
  const panelHeight = options?.panelSize?.height;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hasAnchor || !enabled) return;

    const maxW = window.innerWidth - MARGIN * 2;
    const maxH = window.innerHeight - MARGIN * 2;

    if (resizable && panelWidth != null && panelHeight != null) {
      const naturalWidth = Math.min(Math.max(panelWidth, MIN_WIDTH), maxW);
      const height = Math.min(Math.max(panelHeight, 120), maxH);
      let left = anchorCentered ? anchorLeft - naturalWidth / 2 : anchorLeft;
      let top = anchorTop;

      if (top + height > window.innerHeight - MARGIN) {
        const flippedTop = anchorTop - 6 - height;
        top = flippedTop >= MARGIN ? flippedTop : Math.max(MARGIN, window.innerHeight - MARGIN - height);
      }

      left = Math.min(Math.max(MARGIN, left), window.innerWidth - MARGIN - naturalWidth);
      top = Math.min(Math.max(MARGIN, top), window.innerHeight - MARGIN - height);

      const nextStyle: React.CSSProperties = {
        top,
        left,
        width: naturalWidth,
        height,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      };
      // 布局定位需在 useLayoutEffect 内测量 DOM 后应用样式，setState 是测量结果的应用，属规则误报
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyle((prev) => (styleEqual(prev, nextStyle) ? prev : nextStyle));
      return;
    }

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

    let left = anchorCentered ? anchorLeft - naturalWidth / 2 : anchorLeft;
    let top = anchorTop;

    if (top + height > window.innerHeight - MARGIN) {
      const flippedTop = anchorTop - 6 - height;
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
  }, [
    ref,
    enabled,
    hasAnchor,
    anchorTop,
    anchorLeft,
    anchorCentered,
    remeasureKey,
    resizable,
    panelWidth,
    panelHeight,
  ]);

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
