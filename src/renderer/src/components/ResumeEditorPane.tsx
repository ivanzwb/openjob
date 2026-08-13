import { useEffect, useRef, useState } from 'react';
import { documentToMarkdown, parseMarkdownToDocument } from '@shared/resume/document';
import type { ResumeDocument } from '@shared/resume/document';
import { parsePreviewStyle, serializePreviewStyle } from '@shared/resume/previewStyle';
import type { ResumePreviewStyle } from '@shared/resume/previewStyle';
import { invoke } from '../ipc';
import { ResumeDocumentEditor } from './ResumeDocumentEditor';
import { ResumePreviewDialog } from './ResumePreviewDialog';
import { ResumeTemplatePicker } from './ResumeTemplatePicker';

export interface ResumeEditorSavePayload {
  contentMd: string;
  previewStyle: string;
  label: string;
}

/** 停止输入后多久落库 */
const AUTOSAVE_DELAY_MS = 800;

/**
 * 母版与优化版共用的编辑面板：名称/工具栏 + 模块表单 + 预览弹窗。
 * 编辑即保存，没有保存按钮；正文与模板是面板内部状态，
 * 调用方用 key 区分简历，切换时自然重置草稿。
 */
export function ResumeEditorPane({
  kind,
  initialContentMd,
  initialPreviewStyle,
  initialLabel,
  heading,
  subtitle,
  variantMeta,
  onSave,
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
  onSave: (payload: ResumeEditorSavePayload) => Promise<void>;
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
  const [structuring, setStructuring] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  // AI 重排后表单要按新内容重建，靠它换掉 key
  const [documentNonce, setDocumentNonce] = useState(0);

  const previewMeta: { headline: string; subtitle?: string } = variantMeta ?? { headline: label };

  const payload: ResumeEditorSavePayload = {
    contentMd: documentToMarkdown(resumeDocument),
    previewStyle: serializePreviewStyle(style),
    label: label.trim() || '未命名简历',
  };

  // 打开简历不该触发一次保存，所以基线用归一化后的初始内容
  const [saved, setSaved] = useState<ResumeEditorSavePayload>(() => ({
    contentMd: documentToMarkdown(parseMarkdownToDocument(initialContentMd)),
    previewStyle: serializePreviewStyle(parsePreviewStyle(initialPreviewStyle)),
    label: initialLabel.trim() || '未命名简历',
  }));

  const dirty =
    payload.contentMd !== saved.contentMd ||
    payload.previewStyle !== saved.previewStyle ||
    payload.label !== saved.label;

  const onSaveRef = useRef(onSave);
  const pendingRef = useRef<ResumeEditorSavePayload | null>(null);
  useEffect(() => {
    onSaveRef.current = onSave;
    pendingRef.current = dirty ? payload : null;
  });

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      const next = pendingRef.current;
      if (!next) return;
      pendingRef.current = null;
      // 先记为已尝试：失败也不要每 800ms 重试一次，等用户下一次改动
      setSaved(next);
      setSaveState('saving');
      onSaveRef
        .current(next)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('idle'));
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, payload.contentMd, payload.previewStyle, payload.label]);

  // 切换简历时把没落库的改动补上；此时 onSave 仍指向本份简历
  useEffect(() => {
    return () => {
      const next = pendingRef.current;
      if (next) void onSaveRef.current(next).catch(() => undefined);
    };
  }, []);

  const aiStructure = async (): Promise<void> => {
    setStructuring(true);
    try {
      const res = await invoke('resume:aiStructure', { contentMd: payload.contentMd });
      setResumeDocument(parseMarkdownToDocument(res.contentMd));
      setDocumentNonce((n) => n + 1);
      setActiveSectionIndex(0);
      onMessage('已按 AI 识别结果重排模块');
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setStructuring(false);
    }
  };

  const polishSection = async (req: {
    sectionKey: string;
    contentMd: string;
    instruction: string;
    scopeLabel?: string;
  }): Promise<string> => {
    const res = await invoke('resume:aiPolish', {
      resumeMd: payload.contentMd,
      sectionKey: req.sectionKey,
      scopeLabel: req.scopeLabel,
      contentMd: req.contentMd,
      instruction: req.instruction,
    });
    return res.contentMd;
  };

  const exportPdf = async (): Promise<void> => {
    const stem = variantMeta ? variantMeta.subtitle : label.trim() || '母版';
    const res = await invoke('resume:exportPdf', {
      fileStem: `OpenJob-Resume-${stem}`,
      contentMd: payload.contentMd,
      previewStyle: payload.previewStyle,
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
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {subtitle}
            {saveState !== 'idle' && (
              <span className="ml-2">{saveState === 'saving' ? '保存中…' : '已自动保存'}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={structuring}
            title="内容归类不对时，用模型重新分到各模块；只归类不改写"
            onClick={() => void aiStructure()}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {structuring ? '识别中…' : 'AI 识别'}
          </button>
          <ResumeTemplatePicker
            resumeDocument={resumeDocument}
            style={style}
            onStyleChange={setStyle}
            previewMeta={previewMeta}
          />
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
        </div>
      </div>

      <ResumeDocumentEditor
        document={resumeDocument}
        activeSectionIndex={activeSectionIndex}
        onDocumentChange={setResumeDocument}
        onActiveSectionChange={setActiveSectionIndex}
        onPolish={polishSection}
        documentKey={String(documentNonce)}
      />

      {previewOpen && (
        <ResumePreviewDialog
          resumeDocument={resumeDocument}
          style={style}
          previewMeta={previewMeta}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
