import { useCallback, useEffect, useState } from 'react';
import type { CampaignSummary } from '@shared/ipc';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { runTask } from '../ipc/taskStore';
import { PageShell } from '../components/PageShell';
import { TaskButton } from '../components/TaskButton';

export function CampaignList({
  onOpen,
  onCreate,
}: {
  onOpen: (id: string) => void;
  onCreate: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    void invoke('campaign:list', undefined).then(setItems);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void invoke('campaign:list', undefined)
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useDataRefresh(refresh);

  const remove = (id: string): void => {
    if (!confirm('确定删除这场备考？')) return;
    void runTask(`campaign:delete:${id}`, () => invoke('campaign:delete', { id }))
      .then(refresh)
      .catch(() => undefined);
  };

  return (
    <PageShell className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">备考战役</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            新建备考时选择目标岗位；简历与定向优化请使用顶部「简历」页
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
        >
          新建
        </button>
      </header>

      {loading ? (
        <p className="text-sm text-[var(--color-muted)]">加载中…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">还没有备考战役，点击「新建」开始</p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
            >
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="font-medium">{c.company} · {c.roleTitle}</div>
                <div className="text-xs text-[var(--color-muted)]">
                  {c.nodeCount} 考点 · {c.status}
                  {c.interviewDate ? ` · 面试 ${c.interviewDate}` : ''}
                  {c.hasResume ? ' · 已挂简历' : ''}
                </div>
              </button>
              <TaskButton
                taskKey={`campaign:delete:${c.id}`}
                onClick={() => remove(c.id)}
                runningLabel="删除中…"
                className="text-xs text-[var(--color-muted)] hover:text-red-400 disabled:opacity-50"
              >
                删除
              </TaskButton>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
