import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResumeDocument } from '@shared/resume/document';
import type { ResumePreviewStyle } from '@shared/resume/previewStyle';
import { buildResumeDocumentHtml } from '@shared/resume/renderHtml';
import type { ResumeTemplateId } from '@shared/resume/templates';
import { RESUME_TEMPLATE_META, RESUME_TEMPLATES } from '@shared/resume/templates';
import { useAdaptivePopover } from '../lib/popoverLayout';

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const THUMB_WIDTH = 186;
const THUMB_SCALE = THUMB_WIDTH / PAGE_WIDTH;
const THUMB_HEIGHT = Math.round(PAGE_HEIGHT * THUMB_SCALE);

type PreviewMeta = { headline?: string; subtitle?: string; photo?: string | null };

/** 缩略图直接用当前简历渲染，所见即所得，不会和模板本体走偏 */
function TemplateThumb({
  resumeDocument,
  template,
  previewMeta,
}: {
  resumeDocument: ResumeDocument;
  template: ResumeTemplateId;
  previewMeta?: PreviewMeta;
}): React.JSX.Element {
  const html = buildResumeDocumentHtml(resumeDocument, { template }, previewMeta);
  return (
    <div
      className="overflow-hidden rounded bg-white"
      style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
    >
      <iframe
        title={RESUME_TEMPLATE_META[template].label}
        srcDoc={html}
        sandbox=""
        tabIndex={-1}
        style={{
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          border: 0,
          transform: `scale(${THUMB_SCALE})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

function TemplatePickerPanel({
  resumeDocument,
  style,
  anchor,
  previewMeta,
  triggerRef,
  onPick,
  onClose,
}: {
  resumeDocument: ResumeDocument;
  style: ResumePreviewStyle;
  anchor: DOMRect;
  previewMeta?: PreviewMeta;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (template: ResumeTemplateId) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const popoverStyle = useAdaptivePopover(ref, anchor, true);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return;
      // 触发按钮自己负责收起，否则会先关再开
      if (triggerRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, triggerRef]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[110] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
      style={popoverStyle}
    >
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        选择模板（缩略图为当前简历的真实排版）
      </p>
      <div className="grid grid-cols-3 gap-3">
        {RESUME_TEMPLATES.map((id) => {
          const selected = style.template === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              className={`rounded-lg border p-1.5 text-left transition-colors ${
                selected
                  ? 'border-[var(--color-accent)] bg-[var(--color-bg)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/60'
              }`}
              style={{ width: THUMB_WIDTH + 12 }}
            >
              <TemplateThumb
                resumeDocument={resumeDocument}
                template={id}
                previewMeta={previewMeta}
              />
              <span className="mt-1.5 flex items-center gap-1 text-xs font-medium">
                {RESUME_TEMPLATE_META[id].label}
                {selected && <span className="text-[var(--color-accent)]">·当前</span>}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[var(--color-muted)]">
                {RESUME_TEMPLATE_META[id].hint}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

export function ResumeTemplatePicker({
  resumeDocument,
  style,
  onStyleChange,
  previewMeta,
}: {
  resumeDocument: ResumeDocument;
  style: ResumePreviewStyle;
  onStyleChange: (style: ResumePreviewStyle) => void;
  previewMeta?: PreviewMeta;
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const current = RESUME_TEMPLATE_META[style.template];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() =>
          setAnchor((prev) => (prev ? null : (buttonRef.current?.getBoundingClientRect() ?? null)))
        }
        className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-colors ${
          anchor
            ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
            : 'border-[var(--color-border)] hover:bg-[var(--color-surface)]/60'
        }`}
      >
        <span className="min-w-0">
          <span className="block text-xs font-medium">{current.label}</span>
          <span className="block truncate text-[11px] text-[var(--color-muted)]">
            {current.hint}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-[var(--color-muted)]">▾</span>
      </button>
      {anchor && (
        <TemplatePickerPanel
          resumeDocument={resumeDocument}
          style={style}
          anchor={anchor}
          previewMeta={previewMeta}
          triggerRef={buttonRef}
          onPick={(template) => {
            onStyleChange({ ...style, template });
            setAnchor(null);
          }}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
