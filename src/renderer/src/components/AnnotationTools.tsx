import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { Annotation } from '@shared/entities';
import type { AnnotationTarget } from '@shared/enums';
import { findMarkOnSelection } from '@shared/annotationMarkList';
import { highlightTextStyle } from '../lib/highlightStyle';
import { getSelectionStartInMarkdown } from '../lib/selectionOffset';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';

/**
 * 划词 / 高亮 / 笔记等标注工具（讲解、真题、情报卡等正文区域复用）。
 *
 * 选区操作依赖 scopeRef 内的 mouseup/selectionchange；
 * 高亮颜色与删除逻辑与 ExplanationPanel 共用。
 * 标记列表面板用于情报卡、真题等非讲解场景。
 */

export function findHighlightMark(
  text: string,
  marks: Annotation[],
  selectionStart?: number,
): Annotation | undefined {
  return findMarkOnSelection(marks, 'highlight', text, selectionStart);
}

export const HIGHLIGHT_COLORS = [
  '#fef08a',
  '#fda4af',
  '#7dd3fc',
  '#a7f3d0',
  '#c4b5fd',
  '#fdba74',
];

export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0];

export function HighlightColorPicker({
  color,
  onColorChange,
}: {
  color: string;
  onColorChange: (color: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onColorChange(c)}
          className={`h-5 w-5 rounded border border-black/20 ${
            color === c
              ? 'ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-bg)]'
              : ''
          }`}
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}
      <input
        type="color"
        value={color}
        onChange={(e) => onColorChange(e.target.value)}
        className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
        title="自定义颜色"
      />
    </div>
  );
}

export function selectionWithin(scope: HTMLElement | null): string {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text) return '';
  if (scope && sel?.anchorNode && !scope.contains(sel.anchorNode)) return '';
  return text;
}

export interface SelectionAnchor {
  text: string;
  top: number;
  left: number;
  selectionStart?: number;
}

/** 在容器内取选区锚点，供划选悬浮 popover 定位 */
export function getSelectionAnchor(
  scope: HTMLElement | null,
  contentMd?: string,
): SelectionAnchor | null {
  const sel = window.getSelection();
  const rawText = sel?.toString() ?? '';
  const text = rawText.trim();
  if (!text) return null;
  if (scope && sel?.anchorNode && !scope.contains(sel.anchorNode)) return null;
  if (!sel || sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  let selectionStart: number | undefined;
  if (contentMd) {
    const rawStart = getSelectionStartInMarkdown(scope, contentMd);
    if (rawStart !== null) {
      const leadingTrim = rawText.indexOf(text);
      selectionStart = leadingTrim >= 0 ? rawStart + leadingTrim : rawStart;
    }
  }

  return {
    text,
    top: rect.bottom + 6,
    left: rect.left + rect.width / 2,
    ...(selectionStart !== undefined ? { selectionStart } : {}),
  };
}

function markKindLabel(kind: Annotation['kind']): string {
  if (kind === 'highlight') return '高亮';
  if (kind === 'elaboration') return '细化';
  return '笔记';
}

export function useAnnotationTools({
  targetType,
  targetId,
  scopeRef,
  onChange,
}: {
  targetType: AnnotationTarget;
  targetId: string;
  scopeRef?: RefObject<HTMLElement | null>;
  onChange?: () => void;
}): {
  annotations: Annotation[];
  bookmarked: boolean;
  marks: Annotation[];
  showNote: boolean;
  setShowNote: (v: boolean | ((prev: boolean) => boolean)) => void;
  noteText: string;
  setNoteText: (v: string) => void;
  toggleBookmark: () => void;
  addHighlight: () => void;
  highlightText: (text: string, color?: string, selectionStart?: number) => Promise<void>;
  addNote: () => void;
  addNoteOnSelection: (
    selectedText: string,
    noteMd: string,
    selectionStart?: number,
  ) => Promise<void>;
  addElaborationOnSelection: (
    selectedText: string,
    elaborationMd: string,
    selectionStart?: number,
  ) => Promise<void>;
  deleteMark: (id: string) => void;
} {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [noteText, setNoteText] = useState('');
  const [showNote, setShowNote] = useState(false);

  const load = useCallback(() => {
    if (!targetId) return;
    void invoke('annotation:list', { targetType, targetId }).then(setAnnotations);
  }, [targetType, targetId]);

  useEffect(load, [load]);

  // 细化/笔记可能是在别处落库的（手机端同步过来、或面板卸载期间任务才跑完），
  // 数据版本 bump 时重拉，标记才不会等到下次重挂载才出现
  useDataRefresh(load);

  const refresh = (): void => {
    load();
    onChange?.();
  };

  const bookmarked = annotations.some((a) => a.kind === 'bookmark');
  const marks = annotations.filter(
    (a) => a.kind === 'highlight' || a.kind === 'note' || a.kind === 'elaboration',
  );

  const highlightText = async (
    text: string,
    color = DEFAULT_HIGHLIGHT_COLOR,
    selectionStart?: number,
  ): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await invoke('annotation:create', {
      targetType,
      targetId,
      kind: 'highlight',
      selectedText: trimmed.slice(0, 500),
      highlightColor: color,
      ...(selectionStart !== undefined ? { selectionStart } : {}),
    });
    refresh();
    window.getSelection()?.removeAllRanges();
  };

  return {
    annotations,
    bookmarked,
    marks,
    showNote,
    setShowNote,
    noteText,
    setNoteText,
    toggleBookmark: () => {
      void invoke('annotation:toggleBookmark', { targetType, targetId }).then(refresh);
    },
    addHighlight: () => {
      const text = selectionWithin(scopeRef?.current ?? null);
      if (!text) return;
      void highlightText(text);
    },
    highlightText,
    addNote: () => {
      const text = noteText.trim();
      if (!text) return;
      void invoke('annotation:create', { targetType, targetId, kind: 'note', noteMd: text }).then(
        () => {
          setNoteText('');
          setShowNote(false);
          refresh();
        },
      );
    },
    addNoteOnSelection: async (
      selectedText: string,
      noteMd: string,
      selectionStart?: number,
    ) => {
      const note = noteMd.trim();
      const sel = selectedText.trim();
      if (!note) return;
      await invoke('annotation:create', {
        targetType,
        targetId,
        kind: 'note',
        noteMd: note,
        selectedText: sel ? sel.slice(0, 500) : undefined,
        ...(selectionStart !== undefined ? { selectionStart } : {}),
      });
      setNoteText('');
      setShowNote(false);
      refresh();
      window.getSelection()?.removeAllRanges();
    },
    addElaborationOnSelection: async (
      selectedText: string,
      elaborationMd: string,
      selectionStart?: number,
    ) => {
      const md = elaborationMd.trim();
      const sel = selectedText.trim();
      if (!md) return;
      await invoke('annotation:create', {
        targetType,
        targetId,
        kind: 'elaboration',
        noteMd: md,
        selectedText: sel ? sel.slice(0, 500) : undefined,
        ...(selectionStart !== undefined ? { selectionStart } : {}),
      });
      refresh();
      window.getSelection()?.removeAllRanges();
    },
    deleteMark: (id: string) => invoke('annotation:delete', { id }).then(refresh),
  };
}

function AnnotationMarksPanel({
  marks,
  showNote,
  noteText,
  notePlaceholder,
  onNoteTextChange,
  onAddNote,
  onDelete,
}: {
  marks: Annotation[];
  showNote: boolean;
  noteText: string;
  notePlaceholder: string;
  onNoteTextChange: (v: string) => void;
  onAddNote: () => void;
  onDelete: (id: string) => void;
}): React.JSX.Element | null {
  if (!showNote && marks.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-[var(--color-border)] px-3 py-2 text-xs">
      {showNote && (
        <div className="flex gap-2">
          <input
            value={noteText}
            onChange={(e) => onNoteTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAddNote();
            }}
            placeholder={notePlaceholder}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
          />
          <button
            type="button"
            disabled={!noteText.trim()}
            onClick={onAddNote}
            className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 disabled:opacity-40"
          >
            添加
          </button>
        </div>
      )}
      {marks.length > 0 && (
        <ul className="space-y-1">
          {marks.map((a) => (
            <li
              key={a.id}
              className="flex items-start justify-between gap-2 rounded bg-black/20 px-2 py-1"
            >
              <span className="min-w-0">
                <span className="mr-1 text-[10px] text-[var(--color-muted)]">
                  {markKindLabel(a.kind)}
                </span>
                {a.kind === 'highlight' ? (
                  <span className="rounded px-0.5" style={highlightTextStyle(a.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR)}>
                    {a.selectedText}
                  </span>
                ) : (
                  a.noteMd
                )}
              </span>
              <button
                type="button"
                onClick={() => onDelete(a.id)}
                className="shrink-0 text-[var(--color-muted)] hover:text-red-400"
              >
                {a.kind === 'highlight' ? '去掉' : '删'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const toolbarBtn =
  'rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-black/20 hover:text-[var(--color-fg)]';

export function AnnotationTools({
  targetType,
  targetId,
  scopeRef,
  showBookmark = true,
  notePlaceholder = '写条笔记，只有自己写下的才记得住',
  onChange,
  variant = 'full',
}: {
  targetType: AnnotationTarget;
  targetId: string;
  scopeRef?: RefObject<HTMLElement | null>;
  showBookmark?: boolean;
  notePlaceholder?: string;
  onChange?: () => void;
  variant?: 'full' | 'toolbar' | 'marks';
}): React.JSX.Element {
  const {
    bookmarked,
    marks,
    showNote,
    setShowNote,
    noteText,
    setNoteText,
    toggleBookmark,
    addHighlight,
    addNote,
    deleteMark,
  } = useAnnotationTools({ targetType, targetId, scopeRef, onChange });

  const toolbar = (
    <>
      {showBookmark && (
        <button
          type="button"
          onClick={toggleBookmark}
          className={`${toolbarBtn} ${bookmarked ? 'text-amber-300' : ''}`}
          title={bookmarked ? '取消收藏' : '收藏'}
        >
          {bookmarked ? '★ 已收藏' : '☆ 收藏'}
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={addHighlight}
        className={toolbarBtn}
        title="先在正文中划选文字，再高亮"
      >
        划词高亮
      </button>
      <button type="button" onClick={() => setShowNote((v) => !v)} className={toolbarBtn}>
        {showNote ? '收起笔记' : '记笔记'}
      </button>
      {marks.length > 0 && variant !== 'toolbar' && (
        <span className="px-1 text-[var(--color-muted)]">{marks.length} 条标记</span>
      )}
    </>
  );

  if (variant === 'toolbar') {
    return <>{toolbar}</>;
  }

  const marksPanel = (
    <AnnotationMarksPanel
      marks={marks}
      showNote={showNote}
      noteText={noteText}
      notePlaceholder={notePlaceholder}
      onNoteTextChange={setNoteText}
      onAddNote={addNote}
      onDelete={deleteMark}
    />
  );

  if (variant === 'marks') {
    return marksPanel ?? <></>;
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">{toolbar}</div>
      {marksPanel}
    </div>
  );
}

export { AnnotationMarksPanel };