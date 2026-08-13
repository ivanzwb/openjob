import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlanDateOption, TaskView, TodayPlan } from '@shared/ipc';
import { PlanDecisionLog } from './PlanDecisionLog';
import { StudyPlanCalendar, todayLocal } from './StudyPlanCalendar';
import { invoke } from '../ipc';

export function StudyPlanCalendarPopover({
  open,
  onClose,
  campaignId,
  nodeCount,
  interviewDate,
  dailyMinutes,
  onInterviewDateChange,
  onDailyMinutesChange,
  planMsg,
  planLogKey,
  onGeneratePlan,
  filterDate,
  onFilterDateChange,
  onOpenTask,
}: {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  nodeCount: number;
  interviewDate: string;
  dailyMinutes: string;
  onInterviewDateChange: (value: string) => void;
  onDailyMinutesChange: (value: string) => void;
  planMsg: string | null;
  planLogKey: number;
  onGeneratePlan: () => Promise<void>;
  filterDate: string | null;
  onFilterDateChange: (date: string | null) => void;
  onOpenTask: (task: TaskView) => void;
}): React.JSX.Element | null {
  const [dateOptions, setDateOptions] = useState<PlanDateOption[]>([]);
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [setupOpen, setSetupOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [prevFilterDate, setPrevFilterDate] = useState(filterDate);

  const taskCountByDate = useMemo(
    () => new Map(dateOptions.map((d) => [d.date, d.taskCount])),
    [dateOptions],
  );
  const hasPlan = dateOptions.length > 0;

  const loadDates = useCallback(() => {
    void invoke('plan:listDates', { campaignId }).then((dates) => {
      setDateOptions(dates);
      if (dates.length === 0) setSetupOpen(true);
    });
  }, [campaignId]);

  const loadPlan = useCallback(
    (date: string) => {
      void invoke('plan:getToday', { campaignId, date }).then(setPlan);
    },
    [campaignId],
  );

  useEffect(() => {
    if (!open) return;
    loadDates();
  }, [loadDates, planLogKey, open]);

  useEffect(() => {
    if (!open) return;
    if (filterDate) loadPlan(filterDate);
  }, [filterDate, loadPlan, planLogKey, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // filterDate 变化时渲染期同步重置（避免 effect 内同步 setState 引发级联渲染）
  if (prevFilterDate !== filterDate) {
    setPrevFilterDate(filterDate);
    if (filterDate) {
      const [y, m] = filterDate.split('-').map(Number);
      if (y && m) setViewMonth(new Date(y, m - 1, 1));
    } else {
      setPlan(null);
    }
  }

  const refresh = (): void => {
    loadDates();
    if (filterDate) loadPlan(filterDate);
  };

  const runGenerate = async (): Promise<void> => {
    setGenerating(true);
    try {
      await onGeneratePlan();
      loadDates();
      setSetupOpen(false);
    } finally {
      setGenerating(false);
    }
  };

  const complete = async (taskId: string): Promise<void> => {
    await invoke('task:complete', { taskId });
    refresh();
  };

  const skip = async (taskId: string): Promise<void> => {
    await invoke('task:skip', { taskId });
    refresh();
  };

  const defer = async (): Promise<void> => {
    setDeferring(true);
    try {
      await invoke('plan:deferToday', { campaignId });
      refresh();
    } finally {
      setDeferring(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default bg-black/20"
        aria-label="关闭日历"
        onClick={onClose}
      />
      <div
        className="absolute right-0 top-full z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
        role="dialog"
        aria-label="学习日历"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">学习日历</span>
          <div className="flex items-center gap-2">
            {filterDate && (
              <button
                type="button"
                onClick={() => onFilterDateChange(null)}
                className="text-xs text-sky-400 hover:underline"
              >
                清除筛选
              </button>
            )}
            {hasPlan && (
              <button
                type="button"
                onClick={() => setSetupOpen((v) => !v)}
                className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                {setupOpen ? '收起编排' : '编排'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              关闭
            </button>
          </div>
        </div>

        {(setupOpen || !hasPlan) && (
          <div className="mb-2 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--color-muted)]">面试日期</span>
                <input
                  type="date"
                  value={interviewDate}
                  onChange={(e) => onInterviewDateChange(e.target.value)}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--color-muted)]">每日分钟</span>
                <input
                  type="number"
                  min={30}
                  max={480}
                  value={dailyMinutes}
                  onChange={(e) => onDailyMinutesChange(e.target.value)}
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={nodeCount === 0 || generating}
              onClick={() => void runGenerate()}
              className="w-full rounded-lg bg-emerald-700 px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {generating ? '生成中…' : hasPlan ? '重新生成计划' : '生成计划'}
            </button>
            {planMsg && (
              <p
                className={`text-[10px] ${planMsg.includes('已生成') ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {planMsg}
              </p>
            )}
            <PlanDecisionLog campaignId={campaignId} reloadKey={planLogKey} />
          </div>
        )}

        {hasPlan ? (
          <>
            <StudyPlanCalendar
              viewMonth={viewMonth}
              onViewMonthChange={setViewMonth}
              taskCountByDate={taskCountByDate}
              selectedDate={filterDate}
              onSelectDate={onFilterDateChange}
              interviewDate={interviewDate || undefined}
            />

            {filterDate && plan && (
              <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                <div className="flex items-center justify-between text-[10px] text-[var(--color-muted)]">
                  <span>
                    {filterDate}
                    {filterDate === todayLocal() ? ' · 今天' : ''} · {plan.completedCount}/{plan.totalCount}
                  </span>
                  {filterDate === todayLocal() && plan.completedCount < plan.totalCount && (
                    <button
                      type="button"
                      disabled={deferring}
                      onClick={() => void defer()}
                      className="text-sky-400 hover:underline disabled:opacity-40"
                    >
                      {deferring ? '顺延中…' : '顺延'}
                    </button>
                  )}
                </div>
                {plan.tasks.length === 0 ? (
                  <p className="text-[10px] text-[var(--color-muted)]">该日无任务</p>
                ) : (
                  plan.tasks.map((t) => (
                    <DayTaskRow
                      key={t.id}
                      task={t}
                      onOpen={() => {
                        if (t.nodeId) {
                          onOpenTask(t);
                          onClose();
                        }
                      }}
                      onComplete={() => void complete(t.id)}
                      onSkip={() => void skip(t.id)}
                    />
                  ))
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">生成计划后，点击日期筛选考点清单</p>
        )}
      </div>
    </>
  );
}

function DayTaskRow({
  task,
  onOpen,
  onComplete,
  onSkip,
}: {
  task: TaskView;
  onOpen: () => void;
  onComplete: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const done = task.status === 'done';
  const skipped = task.status === 'skipped';
  const canOpen = Boolean(task.nodeId) && !done && !skipped;

  return (
    <div className="flex items-center gap-1 rounded border border-[var(--color-border)]/60 bg-[var(--color-surface)] px-2 py-1">
      <button
        type="button"
        disabled={!canOpen}
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-[11px] disabled:cursor-default"
      >
        <span className={done ? 'text-[var(--color-muted)] line-through' : ''}>
          {task.nodeName ?? task.repoUrl ?? task.kind}
        </span>
        {canOpen && <span className="ml-1 text-sky-400">→</span>}
      </button>
      {!done && !skipped && (
        <>
          <button type="button" onClick={onComplete} className="text-[10px] text-[var(--color-accent)]">
            完成
          </button>
          <button type="button" onClick={onSkip} className="text-[10px] text-[var(--color-muted)]">
            跳过
          </button>
        </>
      )}
    </div>
  );
}
