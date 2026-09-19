import type { TaskKind } from '@core/enums';
import type { TaskView } from '@core/ipc';
import { CoverageBadge } from './CoverageBadge';

/** 宿主自己生成的四种任务。岗位包声明的种类不走这张表：任务名由包给出（`kindLabel`）。 */
const HOST_KIND_LABEL: Record<TaskKind, string> = {
  learn: '新学',
  drill: '口述练习',
  review: '复习',
  fallbackScript: '兜底话术',
};

const HOST_KIND_COLOR: Record<TaskKind, string> = {
  learn: 'text-sky-300',
  drill: 'text-amber-300',
  review: 'text-purple-300',
  fallbackScript: 'text-slate-400',
};

function kindLabel(task: TaskView): string {
  return task.kindLabel ?? HOST_KIND_LABEL[task.kind as TaskKind] ?? task.kind;
}

function kindColor(task: TaskView): string {
  return HOST_KIND_COLOR[task.kind as TaskKind] ?? 'text-emerald-300';
}

export function TaskCard({
  task,
  linkToStudy = false,
  onSelect,
  onComplete,
  onSkip,
}: {
  task: TaskView;
  linkToStudy?: boolean;
  onSelect: () => void;
  onComplete: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const done = task.status === 'done';
  const skipped = task.status === 'skipped';
  const canStudy = linkToStudy && Boolean(task.nodeId ?? task.pageId) && !done && !skipped;

  return (
    <div
      className={`rounded-lg border p-3 transition-colors border-[var(--color-border)] bg-[var(--color-surface)] ${
        done ? 'opacity-60' : ''
      } ${canStudy ? 'hover:border-[var(--color-accent)]/50' : ''}`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!canStudy && linkToStudy}
        className="w-full text-left disabled:cursor-default"
      >
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${kindColor(task)}`}>{kindLabel(task)}</span>
          {task.nodeCoverage && <CoverageBadge type={task.nodeCoverage} />}
          <span className="ml-auto text-xs text-[var(--color-muted)]">{task.estMinutes} min</span>
        </div>
        <div className="mt-1 text-sm font-medium">
          {task.nodeName ?? task.kindLabel ?? '（无关联考点）'}
        </div>
        {done && <div className="mt-1 text-xs text-emerald-400">已完成</div>}
        {skipped && <div className="mt-1 text-xs text-[var(--color-muted)]">已跳过</div>}
        {canStudy && <div className="mt-1 text-xs text-sky-400">去学习 →</div>}
      </button>

      {!done && !skipped && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onComplete}
            className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white"
          >
            完成
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)]"
          >
            跳过
          </button>
        </div>
      )}
    </div>
  );
}
