import { useState } from 'react';
import { documentToMarkdown, parseMarkdownToDocument } from '@shared/resume/document';
import type { ResumeDocument } from '@shared/resume/document';
import { parsePreviewStyle, serializePreviewStyle } from '@shared/resume/previewStyle';
import type { ResumePreviewStyle } from '@shared/resume/previewStyle';
import { invoke } from '../ipc';
import { ResumeDocumentEditor } from './ResumeDocumentEditor';
import { ResumePreviewDialog } from './ResumePreviewDialog';

export interface ResumeEditorSavePayload {
  contentMd: string;
  previewStyle: string;
  label: string;
}

/**
 * 母版与优化版共用的编辑面板：名称/工具栏 + 模块表单 + 预览弹窗。
 * 正文与模板是面板内部状态，调用方用 key 区分简历，切换时自然重置草稿。
 */
export function ResumeEditorPane({
  kind,
  initialContentMd,
  initialPreviewStyle,
  initialLabel,
  heading,
  subtitle,
  variantMeta,
  busy,
  onSave,
  onDelete,
  onMessage,
}: {
  kind: 'resume' | 'variant';
  initialContentMd: string;
  initialPreviewStyle: string | null;
  initialLabel: string;
  /** 优化版用固定标题，母版用可编辑名称 */
  heading?: string;
  subtitle: string;
  variantMeta?: { headline: string; subtitle: string };
  busy: boolean;
  onSave: (payload: ResumeEditorSavePayload) => void | Promise<void>;
  onDelete: () => void;
  onMessage: (message: string) => void;
}): React.JSX.Element {
  const [resumeDocument, setResumeDocument] = useState<ResumeDocument>(() =>
    parseMarkdownToDocument(initialContentMd),
  );
  const [style, setStyle] = useState<ResumePreviewStyle>(() =>
    parsePreviewStyle(initialPreviewStyle),
  );
  const [label, setLabel] = useState(initialLabel);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);

  const previewMeta: { headline: string; subtitle?: string } = variantMeta ?? { headline: label };

  const save = (): void => {
    void onSave({
      contentMd: documentToMarkdown(resumeDocument),
      previewStyle: serializePreviewStyle(style),
      label: label.trim() || '未命名简历',
    });
  };

  const exportPdf = async (): Promise<void> => {
    const stem = variantMeta ? variantMeta.subtitle : label.trim() || '母版';
    const res = await invoke('resume:exportPdf', {
      fileStem: `OpenJob-Resume-${stem}`,
      contentMd: documentToMarkdown(resumeDocument),
      previewStyle: serializePreviewStyle(style),
      headline: previewMeta.headline,
      subtitle: previewMeta.subtitle,
    });
    onMessage(res.saved ? `已导出：${res.path}` : '已取消导出');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          {kind === 'variant' ? (
            <h3 className="text-base font-semibold">{heading}</h3>
          ) : (
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="简历名称"
              title="简历名称"
              className="-ml-2 w-full max-w-[420px] rounded border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-[var(--color-border)] focus:border-[var(--color-border)] focus:bg-[var(--color-bg)] focus:outline-none"
            />
          )}
          <p className="mt-1 text-xs text-[var(--color-muted)]">{subtitle}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            预览
          </button>
          <button
            type="button"
            onClick={() => void exportPdf()}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            导出 PDF
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-400"
          >
            删除
          </button>
        </div>
      </div>

      <ResumeDocumentEditor
        document={resumeDocument}
        activeSectionIndex={activeSectionIndex}
        onDocumentChange={setResumeDocument}
        onActiveSectionChange={setActiveSectionIndex}
      />

      {previewOpen && (
        <ResumePreviewDialog
          resumeDocument={resumeDocument}
          style={style}
          previewMeta={previewMeta}
          onStyleChange={setStyle}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
