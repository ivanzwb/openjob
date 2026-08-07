import { useCallback, useEffect, useState } from 'react';
import type { TaskView, TodayPlan } from '@shared/ipc';
import { ExplanationPanel } from '../components/ExplanationPanel';
import { QuizPanel } from '../components/QuizPanel';
import { ReadCodePanel } from '../components/ReadCodePanel';
import { TaskCard } from '../components/TaskCard';
import { invoke } from '../ipc';

export function Today(): React.JSX.Element {
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTask, setActiveTask] = useState<TaskView | null>(null);
  const [deferring, setDeferring] = useState(false);

  const refresh = useCallback(() => {
    void invoke('plan:getToday', {}).then(setPlan).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const complete = async (taskId: string): Promise<void> => {
    await invoke('task:complete', { taskId });
    refresh();
    setActiveTask(null);
  };

  const skip = async (taskId: string): Promise<void> => {
    await invoke('task:skip', { taskId });
    refresh();
    if (activeTask?.id === taskId) setActiveTask(null);
  };

  const defer = async (): Promise<void> => {
    if (!plan?.campaignId) return;
    setDeferring(true);
    try {
      await invoke('plan:deferToday', { campaignId: plan.campaignId });
      refresh();
      setActiveTask(null);
    } finally {
      setDeferring(false);
    }
  };

  if (loading) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载今日任务…</p>;
  }

  if (!plan) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-center text-sm text-[var(--color-muted)]">
        没有进行中的备考战役。请先在「备考」中创建 Campaign 并生成计划。
      </div>
    );
  }

  if (!plan.planDay) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6 text-center">
        <p className="text-sm text-[var(--color-muted)]">
          {plan.company} · {plan.roleTitle} — 今天没有排期任务
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          在 Campaign 详情页设置面试日期并「生成计划」
        </p>
      </div>
    );
  }

  const progress =
    plan.totalCount > 0 ? Math.round((plan.completedCount / plan.totalCount) * 100) : 0;

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 p-6 lg:flex-row">
      <div className="flex min-h-0 w-full flex-col gap-4 lg:w-80 lg:shrink-0">
        <header>
          <h2 className="text-lg font-semibold">今日任务</h2>
          <p className="text-xs text-[var(--color-muted)]">
            {plan.company} · {plan.roleTitle} · {plan.date}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-[var(--color-border)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-[var(--color-muted)]">
              {plan.completedCount}/{plan.totalCount}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            计划 {plan.plannedMinutes} 分钟
          </p>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {plan.tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              active={activeTask?.id === t.id}
              onSelect={() => setActiveTask(t)}
              onComplete={() => void complete(t.id)}
              onSkip={() => void skip(t.id)}
            />
          ))}
        </div>

        {plan.completedCount < plan.totalCount && (
          <button
            type="button"
            onClick={() => void defer()}
            disabled={deferring}
            className="rounded border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            {deferring ? '顺延中…' : '今天没时间，一键顺延'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {!activeTask ? (
          <p className="text-sm text-[var(--color-muted)]">选择左侧任务开始学习</p>
        ) : activeTask.kind === 'readCode' && activeTask.repoId ? (
          <ReadCodePanel
            key={activeTask.repoId}
            repoId={activeTask.repoId}
            onComplete={() => void complete(activeTask.id)}
          />
        ) : !activeTask.nodeId ? (
          <p className="text-sm text-[var(--color-muted)]">选择左侧任务开始学习</p>
        ) : activeTask.kind === 'drill' ? (
          <QuizPanel
            nodeId={activeTask.nodeId}
            nodeName={activeTask.nodeName ?? ''}
            onDone={() => void complete(activeTask.id)}
          />
        ) : activeTask.kind === 'fallbackScript' ? (
          <ExplanationPanel
            nodeId={activeTask.nodeId}
            nodeName={activeTask.nodeName ?? ''}
            fallbackMode
          />
        ) : (
          <ExplanationPanel nodeId={activeTask.nodeId} nodeName={activeTask.nodeName ?? ''} />
        )}
      </div>
    </div>
  );
}
