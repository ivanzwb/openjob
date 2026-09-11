import { useMemo } from 'react';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayLocal(): string {
  return toDateKey(new Date());
}

export function StudyPlanCalendar({
  viewMonth,
  onViewMonthChange,
  taskCountByDate,
  selectedDate,
  onSelectDate,
  interviewDate,
}: {
  viewMonth: Date;
  onViewMonthChange: (month: Date) => void;
  taskCountByDate: Map<string, number>;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  interviewDate?: string;
}): React.JSX.Element {
  const today = todayLocal();
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startPad = (first.getDay() + 6) % 7;
    const daysInMonth = last.getDate();
    const result: Array<{ key: string; day: number; inMonth: boolean }> = [];

    for (let i = 0; i < startPad; i++) {
      const d = new Date(year, month, -startPad + i + 1);
      result.push({ key: toDateKey(d), day: d.getDate(), inMonth: false });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, month, day);
      result.push({ key: toDateKey(d), day, inMonth: true });
    }
    while (result.length % 7 !== 0) {
      const next = result.length - startPad - daysInMonth + 1;
      const d = new Date(year, month + 1, next);
      result.push({ key: toDateKey(d), day: d.getDate(), inMonth: false });
    }
    return result;
  }, [year, month]);

  const shiftMonth = (delta: number): void => {
    onViewMonthChange(new Date(year, month + delta, 1));
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          className="rounded px-2 py-0.5 text-sm text-[var(--color-muted)] hover:bg-black/20 hover:text-[var(--color-fg)]"
          aria-label="上个月"
        >
          ‹
        </button>
        <span className="text-sm font-medium">
          {year} 年 {month + 1} 月
        </span>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          className="rounded px-2 py-0.5 text-sm text-[var(--color-muted)] hover:bg-black/20 hover:text-[var(--color-fg)]"
          aria-label="下个月"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-[var(--color-muted)]">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell) => {
          const count = taskCountByDate.get(cell.key) ?? 0;
          const isToday = cell.key === today;
          const isSelected = cell.key === selectedDate;
          const isInterview = Boolean(interviewDate && cell.key === interviewDate);

          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => {
                if (!cell.inMonth) return;
                onSelectDate(isSelected ? null : cell.key);
              }}
              disabled={!cell.inMonth}
              className={`relative flex aspect-square flex-col items-center justify-center rounded text-xs transition-colors ${
                !cell.inMonth
                  ? 'cursor-default text-[var(--color-muted)]/30'
                  : isSelected
                    ? 'bg-[var(--color-accent)] font-medium text-white'
                    : isToday
                      ? 'bg-[var(--color-accent)]/15 font-medium text-[var(--color-fg)] hover:bg-[var(--color-accent)]/25'
                      : count > 0
                        ? 'text-[var(--color-fg)] hover:bg-black/20'
                        : 'text-[var(--color-muted)] hover:bg-black/10'
              } ${isInterview && !isSelected ? 'ring-1 ring-amber-500/60' : ''}`}
              title={
                count > 0
                  ? `${cell.key} · ${count} 项任务`
                  : isInterview
                    ? `${cell.key} · 面试日`
                    : cell.key
              }
            >
              <span>{cell.day}</span>
              {cell.inMonth && count > 0 && (
                <span
                  className={`mt-0.5 text-[9px] leading-none ${
                    isSelected ? 'text-white/90' : 'text-[var(--color-accent)]'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-muted)]">
        <button
          type="button"
          onClick={() => onSelectDate(null)}
          className={`rounded px-2 py-0.5 ${
            selectedDate === null
              ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
              : 'hover:bg-black/20'
          }`}
        >
          全部考点
        </button>
        <button
          type="button"
          onClick={() => onSelectDate(today)}
          className={`rounded px-2 py-0.5 ${
            selectedDate === today ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]' : 'hover:bg-black/20'
          }`}
        >
          今天
        </button>
        {interviewDate && (
          <span className="text-amber-400/80">面试 {interviewDate.slice(5)}</span>
        )}
      </div>
    </div>
  );
}
