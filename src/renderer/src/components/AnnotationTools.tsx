import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { Annotation } from '@shared/entities';
import type { AnnotationTarget } from '@shared/enums';
import { invoke } from '../ipc';

/**
 * 高亮 / 笔记 / 收藏三件套，五类目标共用。
 *
 * 设计要求「知识点、讲解片段、代码位置、真题、情报卡用同一张表」——
 * 表统一了，入口也得统一，否则用户在讲解里能划重点、在真题上却不能，
 * 复习时就没有一个完整的标记集合可翻。
 */

function selectionWithin(scope: HTMLElement | null): string {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text) return '';
  // 限定在给定容器内，避免把页面别处的选中文本记到这个目标上
  if (scope && sel?.anchorNode && !scope.contains(sel.anchorNode)) return '';
  return text;
}

export function AnnotationTools({
  targetType,
  targetId,
  scopeRef,
  showBookmark = true,
  notePlaceholder = '写条笔记，只有自己写下的才记得住',
  onChange,
}: {
  targetType: AnnotationTarget;
  targetId: string;
  /** 划词高亮只认这个容器内的选区 */
  scopeRef?: RefObject<HTMLElement | null>;
  showBookmark?: boolean;
  notePlaceholder?: string;
  onChange?: () => void;
}): React.JSX.Element {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [noteText, setNoteText] = useState('');
  const [showNote, setShowNote] = useState(false);

  const load = useCallback(() => {
    void invoke('annotation:list', { targetType, targetId }).then(setAnnotations);
  }, [targetType, targetId]);

  useEffect(load, [load]);

  const refresh = (): void => {
    load();
    onChange?.();
  };

  const bookmarked = annotations.some((a) => a.kind === 'bookmark');
  const marks = annotations.filter((a) => a.kind === 'highlight' || a.kind === 'note');

  const addHighlight = (): void => {
    const text = selectionWithin(scopeRef?.current ?? null);
    if (!text) return;
    void invoke('annotation:create', {
      targetType,
      targetId,
      kind: 'highlight',
      selectedText: text.slice(0, 500),
    }).then(refresh);
    window.getSelection()?.removeAllRanges();
  };

  const addNote = (): void => {
    const text = noteText.trim();
    if (!text) return;
    void invoke('annotation:create', { targetType, targetId, kind: 'note', noteMd: text }).then(
      () => {
        setNoteText('');
        setShowNote(false);
        refresh();
      },
    );
  };

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {showBookmark && (
          <button
            type="button"
            onClick={() =>
              void invoke('annotation:toggleBookmark', { targetType, targetId }).then(refresh)
            }
            className={bookmarked ? 'text-amber-300' : 'text-[var(--color-muted)] hover:text-amber-300'}
            title={bookmarked ? '取消收藏' : '收藏'}
          >
            {bookmarked ? '★ 已收藏' : '☆ 收藏'}
          </button>
        )}
        <button
          type="button"
          // 按下时不让浏览器清掉选区，否则 onClick 里就读不到划词内容了
          onMouseDown={(e) => e.preventDefault()}
          onClick={addHighlight}
          className="text-[var(--color-muted)] hover:text-amber-300"
          title="先在正文里划选文字，再点这里"
        >
          划词高亮
        </button>
        <button
          type="button"
          onClick={() => setShowNote((v) => !v)}
          className="text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          {showNote ? '收起笔记' : '记笔记'}
        </button>
        {marks.length > 0 && (
          <span className="text-[var(--color-muted)]">{marks.length} 条标记</span>
        )}
      </div>

      {showNote && (
        <div className="flex gap-2">
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addNote();
            }}
            placeholder={notePlaceholder}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
          />
          <button
            type="button"
            disabled={!noteText.trim()}
            onClick={addNote}
            className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 disabled:opacity-40"
          >
            保存
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
                  {a.kind === 'highlight' ? '高亮' : '笔记'}
                </span>
                {a.kind === 'highlight' ? a.selectedText : a.noteMd}
              </span>
              <button
                type="button"
                onClick={() => void invoke('annotation:delete', { id: a.id }).then(refresh)}
                className="shrink-0 text-[var(--color-muted)] hover:text-red-400"
              >
                删
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
