import type { TaskKind } from '@shared/enums';
import type { TaskView } from '@shared/ipc';
import { CoverageBadge } from './CoverageBadge';

const KIND_LABEL: Record<TaskKind, string> = {
  learn: '新学',
  drill: '口述练习',
  readCode: '读源码',
  review: '复习',
  fallbackScript: '兜底话术',
};

const KIND_COLOR: Record<TaskKind, string> = {
  learn: 'text-sky-300',
  drill: 'text-amber-300',
  readCode: 'text-emerald-300',
  review: 'text-purple-300',
  fallbackScript: 'text-slate-400',
};

export function TaskCard({
  task,
  active,
  onSelect,
  onComplete,
  onSkip,
}: {
  task: TaskView;
  active: boolean;
  onSelect: () => void;
  onComplete: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const done = task.status === 'done';
  const skipped = task.status === 'skipped';

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      } ${done ? 'opacity-60' : ''}`}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${KIND_COLOR[task.kind]}`}>
            {KIND_LABEL[task.kind]}
          </span>
          {task.nodeCoverage && <CoverageBadge type={task.nodeCoverage} />}
          <span className="ml-auto text-xs text-[var(--color-muted)]">{task.estMinutes} min</span>
        </div>
        <div className="mt-1 text-sm font-medium">
          {task.kind === 'readCode'
            ? (task.repoUrl?.replace(/^https?:\/\//, '') ?? '源码阅读')
            : (task.nodeName ?? '（无关联考点）')}
        </div>
        {done && <div className="mt-1 text-xs text-emerald-400">已完成</div>}
        {skipped && <div className="mt-1 text-xs text-[var(--color-muted)]">已跳过</div>}
      </button>

      {!done && !skipped && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onComplete}
            className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs"
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
