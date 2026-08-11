import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Explanation } from '@shared/entities';
import type { ExplanationTier } from '@shared/enums';
import { invoke } from '../ipc';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HighlightColorPicker,
  findHighlightMark,
  getSelectionAnchor,
  type SelectionAnchor,
  useAnnotationTools,
} from './AnnotationTools';
import { MarkdownContent } from './MarkdownContent';
import { AutoResizeTextarea } from './AutoResizeTextarea';
import { useToast } from './Toast';
import { useAdaptivePopover } from '../lib/popoverLayout';

const TIERS: { id: ExplanationTier; label: string }[] = [
  { id: 'oneliner', label: '一句话' },
  { id: 'spoken', label: '口语稿' },
  { id: 'deep', label: '深挖' },
];

const toolbarBtn =
  'rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-black/20 hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40';

function replaceExcerpt(contentMd: string, selected: string, replacement: string): string {
  const sel = selected.trim();
  const rep = replacement.trim();
  if (!sel || !rep) throw new Error('替换内容为空');
  if (contentMd.includes(sel)) return contentMd.replace(sel, rep);
  throw new Error('无法在讲解正文中定位选区，请重新划选');
}

function SelectionFloatingMenu({
  anchor,
  busy,
  onEdit,
  onHighlight,
  onNote,
  onElaborate,
  onSaveSpeech,
}: {
  anchor: SelectionAnchor;
  busy: string | null;
  onEdit: () => void;
  onHighlight: () => void;
  onNote: () => void;
  onElaborate: () => void;
  onSaveSpeech: () => void;
}): React.JSX.Element {
  const menuBtn =
    'whitespace-nowrap rounded px-2 py-1 text-xs hover:bg-[var(--color-accent)]/20 disabled:opacity-40';

  return createPortal(
    <div
      className="fixed z-[100] flex -translate-x-1/2 flex-col items-center"
      style={{ top: anchor.top, left: anchor.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-1 shadow-lg">
        <button type="button" className={menuBtn} disabled={Boolean(busy)} onClick={onEdit}>
          编辑讲解
        </button>
        <button type="button" className={menuBtn} disabled={Boolean(busy)} onClick={onHighlight}>
          {busy === 'highlight' ? '高亮中…' : '划词高亮'}
        </button>
        <button type="button" className={menuBtn} disabled={Boolean(busy)} onClick={onNote}>
          记笔记
        </button>
        <button type="button" className={menuBtn} disabled={Boolean(busy)} onClick={onElaborate}>
          {busy === 'elaborate' ? '细化中…' : '细化讲解'}
        </button>
        <button type="button" className={menuBtn} disabled={Boolean(busy)} onClick={onSaveSpeech}>
          {busy === 'speech' ? '保存中…' : '存入话术库'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

type ActionPanelMode = 'edit' | 'note' | 'highlight';

function SelectionActionPopover({
  mode,
  anchor,
  editDraft,
  noteDraft,
  highlightColor,
  existingHighlight,
  editSaving,
  noteSaving,
  highlightSaving,
  clearHighlightSaving,
  onEditDraftChange,
  onNoteDraftChange,
  onHighlightColorChange,
  onClose,
  onSaveEdit,
  onSaveNote,
  onSaveHighlight,
  onClearHighlight,
}: {
  mode: ActionPanelMode;
  anchor: SelectionAnchor;
  editDraft: string;
  noteDraft: string;
  highlightColor: string;
  existingHighlight: boolean;
  editSaving: boolean;
  noteSaving: boolean;
  highlightSaving: boolean;
  clearHighlightSaving: boolean;
  onEditDraftChange: (v: string) => void;
  onNoteDraftChange: (v: string) => void;
  onHighlightColorChange: (v: string) => void;
  onClose: () => void;
  onSaveEdit: () => void;
  onSaveNote: () => void;
  onSaveHighlight: () => void;
  onClearHighlight: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const popoverStyle = useAdaptivePopover(
    ref,
    { ...anchor, center: true },
    true,
    [mode, editDraft, noteDraft, highlightColor, existingHighlight],
  );

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return;
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
  }, [onClose]);

  const title =
    mode === 'edit' ? '编辑讲解' : mode === 'highlight' ? '划词高亮' : '记笔记';

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[110] min-w-48 max-w-[calc(100vw-16px)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
      style={popoverStyle}
      onMouseDown={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest('textarea, input, select')) return;
        e.preventDefault();
      }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[10px] font-medium text-[var(--color-muted)]">{title}</p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[10px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          关闭
        </button>
      </div>
      {mode !== 'edit' ? (
        <p className="mb-2 line-clamp-2 text-[10px] text-amber-300/90">「{anchor.text}」</p>
      ) : (
        <p className="mb-2 line-clamp-2 text-[10px] text-[var(--color-muted)]">
          替换「{anchor.text}」
        </p>
      )}

      {mode === 'edit' && (
        <AutoResizeTextarea
          value={editDraft}
          onChange={(e) => onEditDraftChange(e.target.value)}
          minRows={4}
          autoFocus
          className="mb-3 box-border w-full max-w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
      )}

      {mode === 'highlight' && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-[var(--color-muted)]">高亮颜色</span>
          <HighlightColorPicker color={highlightColor} onColorChange={onHighlightColorChange} />
        </div>
      )}

      {mode === 'note' && (
        <AutoResizeTextarea
          value={noteDraft}
          onChange={(e) => onNoteDraftChange(e.target.value)}
          minRows={3}
          autoFocus
          placeholder="针对选中内容记笔记…"
          className="mb-3 box-border w-full max-w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
      )}

      <div className="flex items-center justify-between gap-2">
        {mode === 'highlight' && existingHighlight ? (
          <button
            type="button"
            disabled={clearHighlightSaving || highlightSaving}
            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
            onClick={onClearHighlight}
          >
            {clearHighlightSaving ? '清除中…' : '清除高亮'}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" className={toolbarBtn} onClick={onClose}>
            取消
          </button>
          {mode === 'edit' && (
            <button
              type="button"
              disabled={editSaving || !editDraft.trim()}
              className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
              onClick={onSaveEdit}
            >
              {editSaving ? '保存中…' : '保存修改'}
            </button>
          )}
          {mode === 'highlight' && (
            <button
              type="button"
              disabled={highlightSaving || clearHighlightSaving}
              className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
              onClick={onSaveHighlight}
            >
              {highlightSaving ? '保存中…' : existingHighlight ? '更新高亮' : '确认高亮'}
            </button>
          )}
          {mode === 'note' && (
            <button
              type="button"
              disabled={noteSaving || !noteDraft.trim()}
              className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
              onClick={onSaveNote}
            >
              {noteSaving ? '保存中…' : '保存笔记'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ExplanationPanel({
  nodeId,
  nodeName,
  defaultTier = 'spoken',
  fallbackMode = false,
  onComplete,
  onAnnotationChange,
}: {
  nodeId: string;
  nodeName: string;
  defaultTier?: ExplanationTier;
  fallbackMode?: boolean;
  onComplete?: () => void;
  onAnnotationChange?: () => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<ExplanationTier>(defaultTier);
  const [content, setContent] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [showFloatingMenu, setShowFloatingMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [toolbarPanel, setToolbarPanel] = useState<'none' | ActionPanelMode>('none');
  const [popoverAnchor, setPopoverAnchor] = useState<SelectionAnchor | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [highlightColor, setHighlightColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  const [editSaving, setEditSaving] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [highlightSaving, setHighlightSaving] = useState(false);
  const [clearHighlightSaving, setClearHighlightSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<SelectionAnchor | null>(null);
  const toast = useToast();

  const activeTier = fallbackMode ? 'oneliner' : tier;
  const isUserEdited = content?.modelUsed === 'user-edit';
  const hasSelection = Boolean(selection);

  const annotation = useAnnotationTools({
    targetType: 'explanation',
    targetId: content?.id ?? '',
    scopeRef: bodyRef,
    onChange: onAnnotationChange,
  });

  const highlightMarks = annotation.marks.filter((m) => m.kind === 'highlight');
  const inlineMarks = annotation.annotations.filter(
    (m) => m.kind === 'note' || m.kind === 'elaboration',
  );
  const popoverHighlightMark =
    toolbarPanel === 'highlight' && popoverAnchor
      ? findHighlightMark(popoverAnchor.text, highlightMarks, popoverAnchor.selectionStart)
      : undefined;

  const closeActionPanel = useCallback(() => {
    setToolbarPanel('none');
    setPopoverAnchor(null);
    setEditDraft('');
    setNoteDraft('');
    setHighlightColor(DEFAULT_HIGHLIGHT_COLOR);
  }, []);

  const openActionPanel = useCallback((mode: ActionPanelMode) => {
    const sel = selectionRef.current ?? selection;
    if (!sel) return;
    setPopoverAnchor({ ...sel });
    setToolbarPanel(mode);
    setShowFloatingMenu(false);
    if (mode === 'edit') setEditDraft(sel.text);
    if (mode === 'note') setNoteDraft('');
    if (mode === 'highlight') {
      const existing = findHighlightMark(sel.text, highlightMarks, sel.selectionStart);
      setHighlightColor(existing?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR);
    }
  }, [selection, highlightMarks]);

  const applySelectionFromDom = useCallback(() => {
    const anchor = getSelectionAnchor(bodyRef.current, content?.contentMd);
    selectionRef.current = anchor;
    setSelection(anchor);
    setShowFloatingMenu(Boolean(anchor) && toolbarPanel === 'none');
    if (!anchor && toolbarPanel === 'none') {
      setEditDraft('');
      setNoteDraft('');
      setHighlightColor(DEFAULT_HIGHLIGHT_COLOR);
    }
  }, [toolbarPanel, content?.contentMd]);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    selectionRef.current = null;
    setSelection(null);
    setShowFloatingMenu(false);
    closeActionPanel();
  }, [closeActionPanel]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !content) return;

    const onMouseUp = (): void => {
      requestAnimationFrame(() => applySelectionFromDom());
    };

    el.addEventListener('mouseup', onMouseUp);
    return () => el.removeEventListener('mouseup', onMouseUp);
  }, [content, applySelectionFromDom]);

  useEffect(() => {
    const onSelectionChange = (): void => {
      if (toolbarPanel !== 'none') return;
      const anchor = getSelectionAnchor(bodyRef.current, content?.contentMd);
      if (anchor) return;
      selectionRef.current = null;
      setSelection(null);
      setShowFloatingMenu(false);
      setEditDraft('');
      setNoteDraft('');
      setHighlightColor(DEFAULT_HIGHLIGHT_COLOR);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [toolbarPanel, content?.contentMd]);

  const load = async (t: ExplanationTier, forceGenerate = false): Promise<void> => {
    setLoading(true);
    setError(null);
    clearSelection();
    try {
      if (!forceGenerate) {
        const cached = await invoke('explain:get', { nodeId, tier: t });
        if (cached) {
          setContent(cached);
          return;
        }
      }
      const generated = fallbackMode
        ? await invoke('explain:fallback', { nodeId })
        : await invoke('explain:generate', { nodeId, tier: t });
      setContent(generated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      clearSelection();
      try {
        const t = fallbackMode ? 'oneliner' : tier;
        const cached = await invoke('explain:get', { nodeId, tier: t });
        if (cancelled) return;
        if (cached) {
          setContent(cached);
          return;
        }
        const generated = fallbackMode
          ? await invoke('explain:fallback', { nodeId })
          : await invoke('explain:generate', { nodeId, tier: t });
        if (!cancelled) setContent(generated);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, tier, fallbackMode, clearSelection]);

  const patchContent = async (nextMd: string): Promise<void> => {
    if (!content) return;
    const updated = await invoke('explain:update', { id: content.id, contentMd: nextMd });
    setContent(updated);
    toast('已手动修订', { variant: 'warning' });
  };

  const regenerateFull = async (): Promise<void> => {
    const tierLabel = TIERS.find((t) => t.id === activeTier)?.label ?? activeTier;
    const message = isUserEdited
      ? `你已手动修改过讲解。重新生成将覆盖当前「${tierLabel}」内容，确定继续？`
      : `重新生成将覆盖当前「${tierLabel}」讲解内容，确定继续？`;
    if (!confirm(message)) return;

    setRegenerating(true);
    setError(null);
    clearSelection();
    try {
      await load(activeTier, true);
    } finally {
      setRegenerating(false);
    }
  };

  const currentSelection = (): SelectionAnchor | null =>
    popoverAnchor ?? selectionRef.current ?? selection;

  const runOnSelection = async (
    key: string,
    fn: (sel: SelectionAnchor) => Promise<void>,
  ): Promise<void> => {
    const sel = currentSelection();
    if (!sel || !content) return;
    setBusy(key);
    setError(null);
    try {
      await fn(sel);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clearSelectedHighlight = (): void => {
    const sel = currentSelection();
    if (!sel) return;
    const mark = findHighlightMark(sel.text, highlightMarks, sel.selectionStart);
    if (!mark) return;
    void runOnSelection('clear-highlight', async () => {
      setClearHighlightSaving(true);
      try {
        await annotation.deleteMark(mark.id);
        toast('已清除高亮', { variant: 'success' });
        clearSelection();
      } finally {
        setClearHighlightSaving(false);
      }
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {loading && <p className="text-sm text-[var(--color-muted)]">生成讲解中…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {content && !loading && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
              <button
                type="button"
                onClick={annotation.toggleBookmark}
                className={`${toolbarBtn} ${annotation.bookmarked ? 'text-amber-300' : ''}`}
                title={annotation.bookmarked ? '取消收藏' : '收藏'}
              >
                {annotation.bookmarked ? '★ 已收藏' : '☆ 收藏'}
              </button>
              {annotation.marks.length > 0 && (
                <span className="px-1 text-[10px] text-[var(--color-muted)]">
                  {annotation.marks.length} 条标记
                </span>
              )}

              <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />

              <button
                type="button"
                disabled={!hasSelection || Boolean(busy)}
                onClick={() => openActionPanel('edit')}
                className={toolbarBtn}
              >
                编辑讲解
              </button>
              <button
                type="button"
                disabled={!hasSelection || Boolean(busy)}
                onClick={() => openActionPanel('highlight')}
                className={toolbarBtn}
              >
                {busy === 'highlight' ? '高亮中…' : '划词高亮'}
              </button>
              <button
                type="button"
                disabled={!hasSelection || Boolean(busy)}
                onClick={() => openActionPanel('note')}
                className={toolbarBtn}
              >
                记笔记
              </button>
              <button
                type="button"
                disabled={!hasSelection || Boolean(busy)}
                onClick={() => {
                  void runOnSelection('elaborate', async (sel) => {
                    const res = await invoke('explain:elaborate', {
                      nodeId,
                      tier: activeTier,
                      selectedText: sel.text,
                      contextMd: content.contentMd,
                    });
                    await annotation.addElaborationOnSelection(res.selectedText, res.elaborationMd);
                    toast('细化讲解已保存', { variant: 'success' });
                    clearSelection();
                  });
                }}
                className={toolbarBtn}
              >
                {busy === 'elaborate' ? '细化中…' : '细化讲解'}
              </button>
              <button
                type="button"
                disabled={!hasSelection || Boolean(busy)}
                onClick={() => {
                  void runOnSelection('speech', async (sel) => {
                    await invoke('speech:saveFromNode', {
                      nodeId,
                      contentMd: sel.text,
                      tier: activeTier,
                    });
                    toast('选区已存入话术库', { variant: 'success' });
                    clearSelection();
                  });
                }}
                className={toolbarBtn}
              >
                {busy === 'speech' ? '保存中…' : '存入话术库'}
              </button>

              <div className="ml-auto flex items-center gap-1">
                {onComplete && (
                  <button
                    type="button"
                    onClick={onComplete}
                    className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-white"
                  >
                    标记完成
                  </button>
                )}
                {!fallbackMode && (
                  <>
                    {onComplete && <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />}
                    {TIERS.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setTier(t.id);
                          void load(t.id);
                        }}
                        className={`rounded px-2 py-1 text-xs ${
                          tier === t.id
                            ? 'bg-[var(--color-accent)] text-white'
                            : toolbarBtn
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </>
                )}
                <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
                <button
                  type="button"
                  disabled={regenerating}
                  onClick={() => void regenerateFull()}
                  className={toolbarBtn}
                >
                  {regenerating ? '重新生成中…' : '重新生成'}
                </button>
              </div>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
            <div ref={bodyRef} className="prose prose-invert max-w-none text-sm leading-relaxed">
              <MarkdownContent
                text={content.contentMd}
                highlights={highlightMarks.map((m) => ({
                  text: m.selectedText ?? '',
                  color: m.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR,
                  ...(m.selectionStart != null ? { start: m.selectionStart } : {}),
                }))}
                annotations={inlineMarks}
                onDeleteAnnotation={annotation.deleteMark}
              />
            </div>
          </div>
        </div>
      )}

      {showFloatingMenu && selection && content && !loading && toolbarPanel === 'none' && (
        <SelectionFloatingMenu
          anchor={selection}
          busy={busy}
          onEdit={() => openActionPanel('edit')}
          onNote={() => openActionPanel('note')}
          onHighlight={() => openActionPanel('highlight')}
          onElaborate={() => {
            void runOnSelection('elaborate', async (sel) => {
              const res = await invoke('explain:elaborate', {
                nodeId,
                tier: activeTier,
                selectedText: sel.text,
                contextMd: content.contentMd,
              });
              await annotation.addElaborationOnSelection(res.selectedText, res.elaborationMd);
              toast('细化讲解已保存', { variant: 'success' });
              clearSelection();
            });
          }}
          onSaveSpeech={() => {
            void runOnSelection('speech', async (sel) => {
              await invoke('speech:saveFromNode', {
                nodeId,
                contentMd: sel.text,
                tier: activeTier,
              });
              toast('选区已存入话术库', { variant: 'success' });
              clearSelection();
            });
          }}
        />
      )}

      {toolbarPanel !== 'none' && popoverAnchor && content && !loading && (
        <SelectionActionPopover
          mode={toolbarPanel}
          anchor={popoverAnchor}
          editDraft={editDraft}
          noteDraft={noteDraft}
          highlightColor={highlightColor}
          existingHighlight={Boolean(popoverHighlightMark)}
          editSaving={editSaving}
          noteSaving={noteSaving}
          highlightSaving={highlightSaving}
          clearHighlightSaving={clearHighlightSaving}
          onEditDraftChange={setEditDraft}
          onNoteDraftChange={setNoteDraft}
          onHighlightColorChange={setHighlightColor}
          onClose={closeActionPanel}
          onSaveEdit={() => {
            void runOnSelection('edit', async (sel) => {
              setEditSaving(true);
              try {
                const next = replaceExcerpt(content.contentMd, sel.text, editDraft);
                await patchContent(next);
                clearSelection();
              } finally {
                setEditSaving(false);
              }
            });
          }}
          onSaveNote={() => {
            void runOnSelection('note', async (sel) => {
              setNoteSaving(true);
              try {
                await annotation.addNoteOnSelection(sel.text, noteDraft);
                clearSelection();
              } finally {
                setNoteSaving(false);
              }
            });
          }}
          onSaveHighlight={() => {
            void runOnSelection('highlight', async (sel) => {
              setHighlightSaving(true);
              try {
                const existing = findHighlightMark(sel.text, highlightMarks, sel.selectionStart);
                if (existing) {
                  await annotation.deleteMark(existing.id);
                }
                await annotation.highlightText(sel.text, highlightColor, sel.selectionStart);
                clearSelection();
              } finally {
                setHighlightSaving(false);
              }
            });
          }}
          onClearHighlight={clearSelectedHighlight}
        />
      )}

      {!content && !loading && (
        <p className="text-sm text-[var(--color-muted)]">暂无「{nodeName}」的讲解</p>
      )}
    </div>
  );
}
