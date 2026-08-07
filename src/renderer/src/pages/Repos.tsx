import { useCallback, useEffect, useState } from 'react';
import type { Repo } from '@shared/entities';
import { RepoWorkspace } from '../components/RepoWorkspace';
import { useJobProgress } from '../ipc/useJobProgress';
import { invoke } from '../ipc';

export function Repos(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const { active, lastMessage } = useJobProgress();

  const refresh = useCallback(() => {
    void invoke('repo:list', undefined).then((list) => {
      setRepos(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!active) refresh();
  }, [active, refresh]);

  const add = async (): Promise<void> => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await invoke('repo:add', { url: trimmed });
      setUrl('');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!confirm('确定删除该仓库及本地 clone？')) return;
    await invoke('repo:delete', { id });
    if (selectedId === id) setSelectedId(null);
    refresh();
  };

  const selected = repos.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-6 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
        <header>
          <h2 className="text-lg font-semibold">源码仓库</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Clone 后自动建 repo map 与项目摘要，供代码 Agent 问答
          </p>
        </header>

        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/..."
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={adding || !url.trim()}
            className="shrink-0 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            添加
          </button>
        </div>

        {active && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
            <div className="font-medium">{active.label}</div>
            <div className="mt-1 text-[var(--color-muted)]">{active.message}</div>
            {active.progress != null && (
              <div className="mt-2 h-1.5 rounded-full bg-[var(--color-border)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)]"
                  style={{ width: `${Math.round(active.progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        {!active && lastMessage && (
          <p className="text-xs text-[var(--color-muted)]">{lastMessage}</p>
        )}

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {repos.length === 0 ? (
            <li className="text-sm text-[var(--color-muted)]">暂无仓库</li>
          ) : (
            repos.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                    selectedId === r.id
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-muted)]'
                  }`}
                >
                  <div className="truncate font-medium">{r.url.replace(/^https?:\/\//, '')}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                    <span
                      className={
                        r.status === 'ready'
                          ? 'text-emerald-400'
                          : r.status === 'indexing'
                            ? 'text-amber-400'
                            : ''
                      }
                    >
                      {r.status === 'ready' ? '已就绪' : r.status === 'indexing' ? '索引中' : r.status}
                    </span>
                    {r.languages.length > 0 && <span>{r.languages.join(', ')}</span>}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(r.id)}
                  className="mt-1 text-xs text-[var(--color-muted)] hover:text-red-400"
                >
                  删除
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-muted)]">
            添加或选择一个仓库开始
          </div>
        ) : (
          <>
            {selected.summaryMd && (
              <details className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <summary className="cursor-pointer text-sm font-medium">项目摘要</summary>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-[var(--color-muted)]">
                  {selected.summaryMd}
                </pre>
              </details>
            )}
            <div className="min-h-0 flex-1">
              <RepoWorkspace repo={selected} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
