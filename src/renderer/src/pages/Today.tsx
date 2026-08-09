import { useCallback, useEffect, useState } from 'react';
import type { PlanDateOption, TaskView, TodayCampaignOption, TodayPlan } from '@shared/ipc';
import { ExplanationPanel } from '../components/ExplanationPanel';
import { QuizPanel } from '../components/QuizPanel';
import { ReadCodePanel } from '../components/ReadCodePanel';
import { TaskCard } from '../components/TaskCard';
import { invoke } from '../ipc';

export function Today(): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<TodayCampaignOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTask, setActiveTask] = useState<TaskView | null>(null);
  const [deferring, setDeferring] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [dateOptions, setDateOptions] = useState<PlanDateOption[]>([]);

  const loadPlan = useCallback((campaignId: string | null) => {
    if (!campaignId) {
      setPlan(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void invoke('plan:getToday', { campaignId })
      .then(setPlan)
      .finally(() => setLoading(false));
  }, []);

  const refreshCampaigns = useCallback(() => {
    void invoke('plan:listTodayCampaigns', undefined).then((list) => {
      setCampaigns(list);
      const next =
        list.find((c) => c.hasPlanToday)?.id ?? list[0]?.id ?? null;
      setSelectedId((prev) => (prev && list.some((c) => c.id === prev) ? prev : next));
    });
  }, []);

  const selectCampaign = useCallback(
    (id: string) => {
      setSelectedId(id);
      setActiveTask(null);
      loadPlan(id);
    },
    [loadPlan],
  );

  useEffect(() => {
    void invoke('plan:listTodayCampaigns', undefined).then((list) => {
      setCampaigns(list);
      const initial =
        list.find((c) => c.hasPlanToday)?.id ?? list[0]?.id ?? null;
      if (initial) {
        setSelectedId(initial);
        setLoading(true);
        void invoke('plan:getToday', { campaignId: initial })
          .then(setPlan)
          .finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });
  }, []);

  const complete = async (taskId: string): Promise<void> => {
    await invoke('task:complete', { taskId });
    loadPlan(selectedId);
    refreshCampaigns();
    setActiveTask(null);
  };

  const skip = async (taskId: string): Promise<void> => {
    await invoke('task:skip', { taskId });
    loadPlan(selectedId);
    refreshCampaigns();
    if (activeTask?.id === taskId) setActiveTask(null);
  };

  const enterEditMode = (): void => {
    setEditMode((prev) => {
      const next = !prev;
      if (next && selectedId) {
        void invoke('plan:listDates', { campaignId: selectedId }).then(setDateOptions);
      }
      return next;
    });
  };

  /**
   * 相邻交换而非拖拽：Electron 里 HTML5 拖放的落点判定很不稳，
   * 上下移动的操作成本几乎一样，但不会点半天点不中。
   */
  const moveWithinDay = async (index: number, delta: number): Promise<void> => {
    if (!plan?.planDay) return;
    const ids = plan.tasks.map((t) => t.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await invoke('task:reorder', { planDayId: plan.planDay.id, taskIds: ids });
    loadPlan(selectedId);
  };

  const rescheduleTask = async (taskId: string, date: string): Promise<void> => {
    await invoke('task:move', { taskId, date });
    loadPlan(selectedId);
    refreshCampaigns();
    if (activeTask?.id === taskId) setActiveTask(null);
  };

  const removeTask = async (taskId: string): Promise<void> => {
    await invoke('task:delete', { taskId });
    loadPlan(selectedId);
    refreshCampaigns();
    if (activeTask?.id === taskId) setActiveTask(null);
  };

  const changeMinutes = async (taskId: string, estMinutes: number): Promise<void> => {
    await invoke('task:setMinutes', { taskId, estMinutes });
    loadPlan(selectedId);
  };

  const defer = async (): Promise<void> => {
    if (!plan?.campaignId) return;
    setDeferring(true);
    try {
      await invoke('plan:deferToday', { campaignId: plan.campaignId });
      loadPlan(selectedId);
      refreshCampaigns();
      setActiveTask(null);
    } finally {
      setDeferring(false);
    }
  };

  if (loading && !plan) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载今日任务…</p>;
  }

  if (campaigns.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-center text-sm text-[var(--color-muted)]">
        没有进行中的备考战役。请先在「备考」中创建 Campaign 并生成计划。
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-center text-sm text-[var(--color-muted)]">
        无法加载今日计划
      </div>
    );
  }

  if (!plan.planDay) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <CampaignSwitcher
          campaigns={campaigns}
          selectedId={selectedId}
          onChange={selectCampaign}
        />
        <p className="text-center text-sm text-[var(--color-muted)]">
          {plan.company} · {plan.roleTitle} — 今天没有排期任务
        </p>
        <p className="text-center text-xs text-[var(--color-muted)]">
          在 Campaign 详情页设置面试日期并「生成计划」
        </p>
      </div>
    );
  }

  const progress =
    plan.totalCount > 0 ? Math.round((plan.completedCount / plan.totalCount) * 100) : 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 p-6 lg:flex-row">
      <div className="flex min-h-0 w-full flex-col gap-4 lg:w-80 lg:shrink-0">
        <header>
          <h2 className="text-lg font-semibold">今日任务</h2>
          <CampaignSwitcher
            campaigns={campaigns}
            selectedId={selectedId}
            onChange={selectCampaign}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">{plan.date}</p>
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
          <div className="mt-1 flex items-center justify-between">
            <p className="text-xs text-[var(--color-muted)]">计划 {plan.plannedMinutes} 分钟</p>
            <button
              type="button"
              onClick={enterEditMode}
              className="text-xs text-sky-400 hover:underline"
            >
              {editMode ? '完成调整' : '调整计划'}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {plan.tasks.map((t, i) => (
            <div key={t.id} className="space-y-1">
              <TaskCard
                task={t}
                active={activeTask?.id === t.id}
                onSelect={() => setActiveTask(t)}
                onComplete={() => void complete(t.id)}
                onSkip={() => void skip(t.id)}
              />
              {editMode && (
                <TaskEditRow
                  task={t}
                  isFirst={i === 0}
                  isLast={i === plan.tasks.length - 1}
                  dateOptions={dateOptions.filter((d) => d.date !== plan.date)}
                  onMove={(delta) => void moveWithinDay(i, delta)}
                  onReschedule={(date) => void rescheduleTask(t.id, date)}
                  onDelete={() => void removeTask(t.id)}
                  onMinutes={(m) => void changeMinutes(t.id, m)}
                />
              )}
            </div>
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
            onComplete={() => void complete(activeTask.id)}
          />
        ) : (
          <ExplanationPanel
            nodeId={activeTask.nodeId}
            nodeName={activeTask.nodeName ?? ''}
            onComplete={() => void complete(activeTask.id)}
          />
        )}
      </div>
    </div>
  );
}

function TaskEditRow({
  task,
  isFirst,
  isLast,
  dateOptions,
  onMove,
  onReschedule,
  onDelete,
  onMinutes,
}: {
  task: TaskView;
  isFirst: boolean;
  isLast: boolean;
  dateOptions: PlanDateOption[];
  onMove: (delta: number) => void;
  onReschedule: (date: string) => void;
  onDelete: () => void;
  onMinutes: (estMinutes: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1 pl-2 text-xs text-[var(--color-muted)]">
      <button
        type="button"
        disabled={isFirst}
        onClick={() => onMove(-1)}
        className="rounded border border-[var(--color-border)] px-1.5 disabled:opacity-30"
        title="上移"
      >
        ↑
      </button>
      <button
        type="button"
        disabled={isLast}
        onClick={() => onMove(1)}
        className="rounded border border-[var(--color-border)] px-1.5 disabled:opacity-30"
        title="下移"
      >
        ↓
      </button>
      <input
        type="number"
        min={5}
        max={240}
        step={5}
        defaultValue={task.estMinutes}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (v && v !== task.estMinutes) onMinutes(v);
        }}
        className="w-14 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-0.5"
        title="预估分钟"
      />
      {dateOptions.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onReschedule(e.target.value);
          }}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-0.5"
        >
          <option value="">改期到…</option>
          {dateOptions.map((d) => (
            <option key={d.date} value={d.date}>
              {d.date.slice(5)}（{d.taskCount} 项）
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="rounded border border-[var(--color-border)] px-1.5 hover:text-red-400"
      >
        删
      </button>
    </div>
  );
}

function CampaignSwitcher({
  campaigns,
  selectedId,
  onChange,
}: {
  campaigns: TodayCampaignOption[];
  selectedId: string | null;
  onChange: (id: string) => void;
}): React.JSX.Element {
  if (campaigns.length <= 1) {
    const c = campaigns[0];
    if (!c) return <></>;
    return (
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {c.company} · {c.roleTitle}
      </p>
    );
  }

  return (
    <select
      value={selectedId ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
    >
      {campaigns.map((c) => (
        <option key={c.id} value={c.id}>
          {c.company} · {c.roleTitle}
          {c.hasPlanToday ? ` (${c.completedCount}/${c.totalCount})` : ' — 今日无排期'}
        </option>
      ))}
    </select>
  );
}
