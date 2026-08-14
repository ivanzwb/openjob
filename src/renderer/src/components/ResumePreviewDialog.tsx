import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResumeDocument } from '@shared/resume/document';
import type { ResumePreviewStyle } from '@shared/resume/previewStyle';
import { buildResumeDocumentHtml } from '@shared/resume/renderHtml';
import { RESUME_TEMPLATE_META } from '@shared/resume/templates';

/** A4 在 96dpi 下的像素尺寸，与导出 PDF 的纸张一致 */
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;

export function ResumePreviewDialog({
  resumeDocument,
  style,
  previewMeta,
  onClose,
}: {
  resumeDocument: ResumeDocument;
  style: ResumePreviewStyle;
  previewMeta?: { headline?: string; subtitle?: string; photo?: string | null };
  onClose: () => void;
}): React.JSX.Element {
  const html = buildResumeDocumentHtml(resumeDocument, style, previewMeta);
  const [contentHeight, setContentHeight] = useState(PAGE_HEIGHT);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const pageCount = Math.max(1, Math.ceil(contentHeight / PAGE_HEIGHT));

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex justify-center bg-scrim p-6"
      // 模板下拉是另一个 portal，只在点到遮罩本身时关闭，避免选模板时把弹窗带走
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-[880px] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              预览
              <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                {RESUME_TEMPLATE_META[style.template].label} · 与导出 PDF 一致
                {pageCount > 1 && ` · 共 ${pageCount} 页，虚线为分页位置`}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            关闭
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-[#e8e4de] p-5">
          <div
            className="relative mx-auto bg-white shadow-lg ring-1 ring-black/10"
            style={{ width: PAGE_WIDTH }}
          >
            <iframe
              title="简历预览"
              srcDoc={html}
              // 允许同源以便量出真实高度；未开 allow-scripts，页面内脚本仍无法执行
              sandbox="allow-same-origin"
              onLoad={(e) => {
                const doc = e.currentTarget.contentDocument;
                if (!doc) return;
                const measured = Math.max(
                  doc.documentElement.scrollHeight,
                  doc.body.scrollHeight,
                );
                setContentHeight(Math.max(PAGE_HEIGHT, measured));
              }}
              style={{ display: 'block', width: '100%', height: contentHeight, border: 0 }}
            />
            {Array.from({ length: pageCount - 1 }).map((_, i) => (
              <div
                key={i}
                className="pointer-events-none absolute inset-x-0 border-t border-dashed border-red-400/50"
                style={{ top: (i + 1) * PAGE_HEIGHT }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
