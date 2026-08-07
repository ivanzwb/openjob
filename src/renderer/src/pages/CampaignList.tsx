import { useCallback, useEffect, useState } from 'react';
import type { CampaignSummary } from '@shared/ipc';
import { invoke } from '../ipc';

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

  const remove = async (id: string): Promise<void> => {
    if (!confirm('确定删除这场备考？')) return;
    await invoke('campaign:delete', { id });
    refresh();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">备考战役</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            每一场具体面试是一个 Campaign，从 JD 诊断开始
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium"
        >
          新建
        </button>
      </header>

      {loading ? (
        <p className="text-sm text-[var(--color-muted)]">加载中…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted)]">
          还没有备考战役。点击「新建」，粘贴 JD 即可开始。
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="font-medium">
                  {c.company} · {c.roleTitle}
                </div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  {c.nodeCount} 个考点
                  {c.hasResume ? ' · 已关联简历' : ''}
                  {c.interviewDate ? ` · 面试 ${c.interviewDate}` : ''}
                </div>
              </button>
              <button
                type="button"
                onClick={() => void remove(c.id)}
                className="shrink-0 text-xs text-[var(--color-muted)] hover:text-red-400"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
