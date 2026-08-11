import { useState } from 'react';
import type { AnnotationView } from '@shared/ipc';
import type { AnnotationTarget } from '@shared/enums';
import { highlightTextStyle } from '../lib/highlightStyle';
import { invoke } from '../ipc';
import { DEFAULT_HIGHLIGHT_COLOR } from './AnnotationTools';

const TARGET_LABEL: Record<AnnotationTarget, string> = {
  node: '知识点',
  explanation: '讲解',
  codeRef: '代码',
  question: '真题',
  intel: '情报',
};

const TARGET_TONE: Record<AnnotationTarget, string> = {
  node: 'text-sky-300 border-sky-500/30 bg-sky-950/30',
  explanation: 'text-violet-300 border-violet-500/30 bg-violet-950/30',
  codeRef: 'text-emerald-300 border-emerald-500/30 bg-emerald-950/30',
  question: 'text-amber-300 border-amber-500/30 bg-amber-950/30',
  intel: 'text-rose-300 border-rose-500/30 bg-rose-950/30',
};

const FILTERS: Array<{ id: AnnotationTarget | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'node', label: '知识点' },
  { id: 'explanation', label: '讲解' },
  { id: 'question', label: '真题' },
  { id: 'intel', label: '情报' },
  { id: 'codeRef', label: '代码' },
];

export function AnnotationDigest({
  annotations,
  onChange,
  onJumpToNode,
  layout = 'wide',
}: {
  annotations: AnnotationView[];
  onChange: () => void;
  onJumpToNode?: (nodeId: string) => void;
  layout?: 'compact' | 'wide';
}): React.JSX.Element {
  const [filter, setFilter] = useState<AnnotationTarget | 'all'>('all');

  const bookmarks = annotations.filter((a) => a.kind === 'bookmark');
  const visible = annotations.filter(
    (a) => (filter === 'all' || a.targetType === filter) && a.kind !== 'bookmark',
  );

  const countFor = (id: AnnotationTarget | 'all'): number =>
    id === 'all'
      ? annotations.filter((a) => a.kind !== 'bookmark').length
      : annotations.filter((a) => a.targetType === id && a.kind !== 'bookmark').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const count = countFor(f.id);
          if (f.id !== 'all' && count === 0) return null;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                filter === f.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {f.label}
              {count > 0 ? ` · ${count}` : ''}
            </button>
          );
        })}
      </div>

      {bookmarks.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3">
          <p className="text-xs font-medium text-amber-300">收藏考点 · {bookmarks.length}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {bookmarks.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onJumpToNode?.(a.targetId)}
                className="rounded-full border border-amber-500/40 px-2.5 py-1 text-xs text-amber-100 hover:bg-amber-900/40"
              >
                ★ {a.targetLabel}
              </button>
            ))}
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-10 text-center">
          <p className="text-sm text-[var(--color-muted)]">还没有标记</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            在讲解、真题、情报卡上划词高亮或记笔记，会汇总到这里
          </p>
        </div>
      ) : layout === 'wide' ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  className={`rounded border px-2 py-0.5 text-[10px] ${TARGET_TONE[a.targetType]}`}
                >
                  {TARGET_LABEL[a.targetType]}
                  {a.kind === 'highlight' ? ' · 高亮' : a.kind === 'elaboration' ? ' · 细化' : ' · 笔记'}
                </span>
                <button
                  type="button"
                  onClick={() => void invoke('annotation:delete', { id: a.id }).then(onChange)}
                  className="text-xs text-[var(--color-muted)] hover:text-red-400"
                >
                  删除
                </button>
              </div>
              {onJumpToNode && a.targetType === 'node' ? (
                <button
                  type="button"
                  onClick={() => onJumpToNode(a.targetId)}
                  className="text-left text-xs font-medium text-[var(--color-fg)] hover:text-[var(--color-accent)]"
                >
                  {a.targetLabel}
                </button>
              ) : (
                <p className="text-xs font-medium text-[var(--color-fg)]">{a.targetLabel}</p>
              )}
              <p className="line-clamp-4 text-sm leading-relaxed text-[var(--color-muted)]">
                {a.kind === 'highlight' ? (
                  <span
                    className="rounded px-0.5"
                    style={highlightTextStyle(a.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR)}
                  >
                    「{a.selectedText}」
                  </span>
                ) : (
                  a.noteMd
                )}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
          {visible.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-2 rounded bg-black/20 px-2 py-1.5 text-xs"
            >
              <span className={`shrink-0 ${TARGET_TONE[a.targetType].split(' ')[0]}`}>
                {TARGET_LABEL[a.targetType]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[10px] text-[var(--color-muted)]">
                  {onJumpToNode && a.targetType === 'node' ? (
                    <button
                      type="button"
                      onClick={() => onJumpToNode(a.targetId)}
                      className="hover:text-[var(--color-fg)] hover:underline"
                    >
                      {a.targetLabel}
                    </button>
                  ) : (
                    a.targetLabel
                  )}
                </div>
                <div className="break-words">
                  {a.kind === 'highlight' ? (
                    <span
                      className="rounded px-0.5 text-[var(--color-fg)]"
                      style={{ backgroundColor: a.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR }}
                    >
                      「{a.selectedText}」
                    </span>
                  ) : (
                    a.noteMd
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void invoke('annotation:delete', { id: a.id }).then(onChange)}
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
