import { useState } from 'react';
import type { AnnotationView } from '@core/ipc';
import type { AnnotationTarget } from '@core/enums';
import { highlightTextStyle } from '../lib/highlightStyle';
import { invoke } from '../ipc';
import { DEFAULT_HIGHLIGHT_COLOR } from './AnnotationTools';

/**
 * 宿主的**跨功能标记汇总**（§「我的标记」）。
 *
 * 这里是宿主认识的标记目标（知识点 / 讲解 / 真题 / 情报）与**包自己起的标记目标**共用的
 * 一张面板：宿主认识的取值照旧按自己的名字与颜色渲染、按目标跳回去；认不出的取值
 * （插件的自由字符串）就按包存下来的标签渲染，没有标签则退回原始取值，只作为一条**信息行**
 * 列出它的标签、笔记与选中文本，不提供跳到别处的导航——宿主不知道那个目标在哪。
 */
const TARGET_LABEL: Record<string, string> = {
  node: '知识点',
  explanation: '讲解',
  question: '真题',
  intel: '情报',
};

const TARGET_TONE: Record<string, string> = {
  node: 'text-sky-300 border-sky-500/30 bg-sky-950/30',
  explanation: 'text-violet-300 border-violet-500/30 bg-violet-950/30',
  question: 'text-amber-300 border-amber-500/30 bg-amber-950/30',
  intel: 'text-rose-300 border-rose-500/30 bg-rose-950/30',
};

/** 宿主不认识的标记目标：中性配色，只作为信息行，没有可跳的目标 */
const UNKNOWN_TONE = 'text-slate-300 border-slate-500/30 bg-slate-800/30';

/** 宿主认识这个标记目标吗？只有认识的取值才有导航（跳回目标） */
function isHostTarget(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(TARGET_LABEL, type);
}

function targetTone(type: string): string {
  return TARGET_TONE[type] ?? UNKNOWN_TONE;
}

/** 目标类型在色签里显示什么：宿主认识的用它的名字，认不出的用包存下来的标签 */
function targetChip(annotation: AnnotationView): string {
  return isHostTarget(annotation.targetType) ? TARGET_LABEL[annotation.targetType] : annotation.targetLabel;
}

function kindSuffix(kind: string): string {
  if (kind === 'highlight') return ' · 高亮';
  if (kind === 'elaboration') return ' · 细化';
  if (kind === 'note') return ' · 笔记';
  return '';
}

const FILTERS: Array<{ id: AnnotationTarget | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'node', label: '知识点' },
  { id: 'explanation', label: '讲解' },
  { id: 'question', label: '真题' },
  { id: 'intel', label: '情报' },
];

/**
 * 一条标记的正文：宿主认识的取值沿用「高亮看选中文本、其余看笔记」的老规矩；
 * 宿主不认识的取值把**选中文本与笔记都列出来**（信息行没有跳转，正文就是它的全部内容）。
 */
function AnnotationBody({ annotation }: { annotation: AnnotationView }): React.JSX.Element {
  if (!isHostTarget(annotation.targetType)) {
    return (
      <>
        {annotation.selectedText ? (
          <span
            className="rounded px-0.5"
            style={highlightTextStyle(annotation.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR)}
          >
            「{annotation.selectedText}」
          </span>
        ) : null}
        {annotation.selectedText && annotation.noteMd ? <br /> : null}
        {annotation.noteMd ?? null}
      </>
    );
  }
  return annotation.kind === 'highlight' ? (
    <span
      className="rounded px-0.5"
      style={highlightTextStyle(annotation.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR)}
    >
      「{annotation.selectedText}」
    </span>
  ) : (
    <>{annotation.noteMd}</>
  );
}

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
                <span className={`rounded border px-2 py-0.5 text-[10px] ${targetTone(a.targetType)}`}>
                  {targetChip(a)}
                  {isHostTarget(a.targetType) ? kindSuffix(a.kind) : ''}
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
              ) : isHostTarget(a.targetType) ? (
                <p className="text-xs font-medium text-[var(--color-fg)]">{a.targetLabel}</p>
              ) : null}
              <p className="line-clamp-4 text-sm leading-relaxed text-[var(--color-muted)]">
                <AnnotationBody annotation={a} />
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
              <span className={`shrink-0 ${targetTone(a.targetType).split(' ')[0]}`}>
                {targetChip(a)}
              </span>
              <div className="min-w-0 flex-1">
                {isHostTarget(a.targetType) ? (
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
                ) : null}
                <div className="break-words">
                  <AnnotationBody annotation={a} />
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
