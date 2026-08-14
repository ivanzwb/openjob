import { useEffect, useRef, useState } from 'react';
import { documentToMarkdown, parseMarkdownToDocument } from '@shared/resume/document';
import type { ResumeDocument, ResumeSectionKey } from '@shared/resume/document';
import { parsePreviewStyle, serializePreviewStyle } from '@shared/resume/previewStyle';
import type { ResumePreviewStyle } from '@shared/resume/previewStyle';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { ResumeDocumentEditor } from './ResumeDocumentEditor';
import { ResumePreviewDialog } from './ResumePreviewDialog';
import { ResumeTemplatePicker } from './ResumeTemplatePicker';
import { TaskButton } from './TaskButton';
import { useToast } from './Toast';
import type { SectionPolishRequest } from './ResumeSectionForm';

export interface ResumeEditorSavePayload {
  contentMd: string;
  previewStyle: string;
  label: string;
  /** 寸照 data URL，null 表示没有照片 */
  photo: string | null;
}

/** 停止输入后多久落库 */
const AUTOSAVE_DELAY_MS = 800;

/**
 * 母版与优化版共用的编辑面板：名称/工具栏 + 模块表单 + 预览弹窗。
 * 编辑即保存，没有保存按钮；正文与模板是面板内部状态，
 * 调用方用 key 区分简历，切换时自然重置草稿。
 *
 * AI 识别与 AI 优化都挂在按简历取的任务 key 上，并在任务内部直接落库：
 * 切走简历、换页、关掉面板都不影响它跑完，回来时按钮态与内容都对得上。
 */
export function ResumeEditorPane({
  kind,
  taskScope,
  initialContentMd,
  initialPreviewStyle,
  initialLabel,
  initialPhoto,
  heading,
  subtitle,
  variantMeta,
  onSave,
  onMessage,
}: {
  kind: 'resume' | 'variant';
  /** 这份简历的稳定标识，用来给 AI 任务取 key */
  taskScope: string;
  initialContentMd: string;
  initialPreviewStyle: string | null;
  initialLabel: string;
  initialPhoto: string | null;
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
  const [photo, setPhoto] = useState<string | null>(initialPhoto);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  // AI 重排后表单要按新内容重建，靠它换掉 key
  const [documentNonce, setDocumentNonce] = useState(0);

  const structureKey = `resume:aiStructure:${taskScope}`;
  const polishKeyPrefix = `resume:aiPolish:${taskScope}`;
  const exportKey = `resume:exportPdf:${taskScope}`;
  const { running: structuring, error: structureError } = useTask(structureKey);
  const toast = useToast();

  const previewMeta: { headline: string; subtitle?: string; photo: string | null } = {
    ...(variantMeta ?? { headline: label }),
    photo,
  };

  const payload: ResumeEditorSavePayload = {
    contentMd: documentToMarkdown(resumeDocument),
    previewStyle: serializePreviewStyle(style),
    label: label.trim() || '未命名简历',
    photo,
  };

  // 打开简历不该触发一次保存，所以基线用归一化后的初始内容
  const [saved, setSaved] = useState<ResumeEditorSavePayload>(() => ({
    contentMd: documentToMarkdown(parseMarkdownToDocument(initialContentMd)),
    previewStyle: serializePreviewStyle(parsePreviewStyle(initialPreviewStyle)),
    label: initialLabel.trim() || '未命名简历',
    photo: initialPhoto,
  }));

  const dirty =
    payload.contentMd !== saved.contentMd ||
    payload.previewStyle !== saved.previewStyle ||
    payload.label !== saved.label ||
    payload.photo !== saved.photo;

  const onSaveRef = useRef(onSave);
  const pendingRef = useRef<ResumeEditorSavePayload | null>(null);
  // AI 任务跑完时可能已经卸载，用 ref 记住最后一次的正文与文档，落库不会写回旧内容
  const payloadRef = useRef(payload);
  const documentRef = useRef(resumeDocument);
  useEffect(() => {
    onSaveRef.current = onSave;
    pendingRef.current = dirty ? payload : null;
    payloadRef.current = payload;
    documentRef.current = resumeDocument;
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
  }, [dirty, payload.contentMd, payload.previewStyle, payload.label, payload.photo]);

  // 切换简历时把没落库的改动补上；此时 onSave 仍指向本份简历
  useEffect(() => {
    return () => {
      const next = pendingRef.current;
      if (next) void onSaveRef.current(next).catch(() => undefined);
    };
  }, []);

  /**
   * 把 AI 产出的正文写进库，并在面板还挂着时同步到表单。
   * 卸载后 setState 是空操作，但库已经写好，下次打开这份简历就能看到。
   */
  const persistContent = async (contentMd: string): Promise<void> => {
    const next = { ...payloadRef.current, contentMd };
    payloadRef.current = next;
    setSaved(next);
    await onSaveRef.current(next);
  };

  const aiStructure = (): void => {
    void runTask(structureKey, async () => {
      const res = await invoke('resume:aiStructure', { contentMd: payloadRef.current.contentMd });
      const normalized = documentToMarkdown(parseMarkdownToDocument(res.contentMd));
      await persistContent(normalized);
      return { contentMd: normalized, fallbackReason: res.fallbackReason };
    }).catch(() => undefined);
  };

  useTaskResult<{ contentMd: string; fallbackReason?: string }>(structureKey, (res) => {
    setResumeDocument(parseMarkdownToDocument(res.contentMd));
    setDocumentNonce((n) => n + 1);
    setActiveSectionIndex(0);
    if (res.fallbackReason) {
      // 结果不是模型给的，说清楚才不会让用户以为模型就这水平
      toast(`模型识别失败，已退回规则识别：${res.fallbackReason}`, { variant: 'warning' });
      onMessage('模型识别失败，已按规则识别重排模块');
    } else {
      onMessage('已按 AI 识别结果重排模块');
    }
  });

  /**
   * 单块润色：模型只返回这一小块文本，由表单给出的 mergeSection 合回模块正文后落库。
   * 任务 key 由表单按「简历 + 模块 + 文本框」拼出，切走再回来仍是同一个任务。
   */
  const polishSection = (
    req: SectionPolishRequest & { sectionKey: ResumeSectionKey },
  ): Promise<string> =>
    runTask(req.taskKey, async () => {
      const res = await invoke('resume:aiPolish', {
        resumeMd: payloadRef.current.contentMd,
        sectionKey: req.sectionKey,
        scopeLabel: req.scopeLabel,
        contentMd: req.contentMd,
        instruction: req.instruction,
      });
      const merged = {
        sections: documentRef.current.sections.map((s) =>
          s.key === req.sectionKey ? { ...s, contentMd: req.mergeSection(res.contentMd) } : s,
        ),
      };
      documentRef.current = merged;
      setResumeDocument(merged);
      await persistContent(documentToMarkdown(merged));
      return res.contentMd;
    });

  const exportPdf = (): void => {
    const stem = variantMeta ? variantMeta.subtitle : label.trim() || '母版';
    const meta = previewMeta;
    void runTask(exportKey, async () => {
      const res = await invoke('resume:exportPdf', {
        fileStem: `OpenJob-Resume-${stem}`,
        contentMd: payloadRef.current.contentMd,
        previewStyle: payloadRef.current.previewStyle,
        headline: meta.headline,
        subtitle: meta.subtitle,
        photo: payloadRef.current.photo,
      });
      return res.saved ? `已导出：${res.path}` : '已取消导出';
    }).catch(() => undefined);
  };

  useTaskResult<string>(exportKey, onMessage);

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
            {structuring && <span className="ml-2">AI 识别进行中…</span>}
          </p>
          {structureError && <p className="mt-1 text-xs text-red-400">{structureError}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={structuring}
            title="内容归类不对时，用模型重新分到各模块；只归类不改写"
            onClick={aiStructure}
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
          <TaskButton
            taskKey={exportKey}
            onClick={exportPdf}
            runningLabel="导出中…"
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            导出 PDF
          </TaskButton>
        </div>
      </div>

      <ResumeDocumentEditor
        document={resumeDocument}
        activeSectionIndex={activeSectionIndex}
        photo={photo}
        onPhotoChange={setPhoto}
        onDocumentChange={setResumeDocument}
        onActiveSectionChange={setActiveSectionIndex}
        onPolish={polishSection}
        polishTaskKeyPrefix={polishKeyPrefix}
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
