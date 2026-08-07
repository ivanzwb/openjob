import { useState } from 'react';
import type { AnnotationView } from '@shared/ipc';
import type { AnnotationTarget } from '@shared/enums';
import { invoke } from '../ipc';

const TARGET_LABEL: Record<AnnotationTarget, string> = {
  node: '知识点',
  explanation: '讲解',
  codeRef: '代码',
  question: '真题',
  intel: '情报',
};

const TARGET_TONE: Record<AnnotationTarget, string> = {
  node: 'text-sky-300',
  explanation: 'text-violet-300',
  codeRef: 'text-emerald-300',
  question: 'text-amber-300',
  intel: 'text-rose-300',
};

const FILTERS: Array<{ id: AnnotationTarget | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'node', label: '知识点' },
  { id: 'explanation', label: '讲解' },
  { id: 'question', label: '真题' },
  { id: 'intel', label: '情报' },
];

/**
 * 跨五类目标的标记汇总。
 *
 * 标记散在各自的界面里等于没有——临考前需要的是一份「我圈过的所有东西」，
 * 一次翻完，而不是挨个页面回去找。
 */
export function AnnotationDigest({
  annotations,
  onChange,
  onJumpToNode,
}: {
  annotations: AnnotationView[];
  onChange: () => void;
  onJumpToNode?: (nodeId: string) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<AnnotationTarget | 'all'>('all');

  const visible = annotations.filter(
    (a) => (filter === 'all' || a.targetType === filter) && a.kind !== 'bookmark',
  );
  const bookmarks = annotations.filter((a) => a.kind === 'bookmark');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {FILTERS.map((f) => {
          const count =
            f.id === 'all'
              ? annotations.filter((a) => a.kind !== 'bookmark').length
              : annotations.filter((a) => a.targetType === f.id && a.kind !== 'bookmark').length;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded px-2 py-0.5 ${
                filter === f.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'border border-[var(--color-border)] text-[var(--color-muted)]'
              }`}
            >
              {f.label} {count > 0 && count}
            </button>
          );
        })}
        {bookmarks.length > 0 && (
          <span className="ml-auto text-[var(--color-muted)]">★ {bookmarks.length} 收藏</span>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          还没有标记。在讲解、代码、真题、情报卡上划词高亮或记笔记，都会汇总到这里。
        </p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
          {visible.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-2 rounded bg-black/20 px-2 py-1.5 text-xs"
            >
              <span className={`shrink-0 ${TARGET_TONE[a.targetType]}`}>
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
                  {a.kind === 'highlight' ? `「${a.selectedText}」` : a.noteMd}
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
