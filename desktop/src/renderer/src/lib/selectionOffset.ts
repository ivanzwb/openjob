function isAnnotationUiNode(node: Node): boolean {
  return Boolean((node as Element).closest?.('[data-annotation-ui]'));
}

function getTextOffsetBefore(
  container: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (isAnnotationUiNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let offset = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current === targetNode) return offset + targetOffset;
    offset += current.textContent?.length ?? 0;
  }
  return -1;
}

function getRangeStartOffset(container: HTMLElement, range: Range): number {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return getTextOffsetBefore(container, startContainer, startOffset);
  }
  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    const el = startContainer as Element;
    const child = el.childNodes[startOffset];
    if (child?.nodeType === Node.TEXT_NODE) {
      return getTextOffsetBefore(container, child, 0);
    }
    if (child) {
      const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (isAnnotationUiNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const first = walker.nextNode();
      if (first) return getTextOffsetBefore(container, first, 0);
    }
  }
  return -1;
}

/** Map the current DOM selection to an offset in the markdown source string. */
export function getSelectionStartInMarkdown(
  scope: HTMLElement | null,
  contentMd: string,
): number | null {
  if (!scope) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const startNode =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const textBlock = startNode?.closest('[data-md-start]');
  if (!textBlock || !scope.contains(textBlock)) return null;

  const mdStart = Number(textBlock.getAttribute('data-md-start'));
  if (Number.isNaN(mdStart)) return null;

  const offsetInBlock = getRangeStartOffset(textBlock as HTMLElement, range);
  if (offsetInBlock < 0) return null;

  const selectionStart = mdStart + offsetInBlock;
  if (selectionStart < 0 || selectionStart > contentMd.length) return null;
  return selectionStart;
}
