import { useCallback, useEffect, useRef, useState } from 'react';
import type { Repo } from '@shared/entities';
import type { GitStatus } from '@shared/ipc';
import { MarkdownContent } from '../components/MarkdownContent';
import { PageShell } from '../components/PageShell';
import { RepoWorkspace } from '../components/RepoWorkspace';
import { TaskButton } from '../components/TaskButton';
import { useToast } from '../components/Toast';
import { useJobFeedback, useJobProgress } from '../ipc/useJobProgress';
import { invoke } from '../ipc';
import { runTask } from '../ipc/taskStore';

type RepoTab = 'summary' | 'qa';

const REPO_TABS: { id: RepoTab; label: string }[] = [
  { id: 'summary', label: '项目摘要' },
  { id: 'qa', label: '问答' },
];

function RepoSummaryPanel({ repo }: { repo: Repo }): React.JSX.Element {
  if (repo.summaryMd) {
    return (
      <div className="prose prose-invert max-w-none text-sm">
        <MarkdownContent text={repo.summaryMd} />
      </div>
    );
  }

  if (repo.repoMapMd) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-[var(--color-muted)]">Repo Map（节选）</p>
        <pre className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap font-mono text-xs text-[var(--color-muted)]">
          {repo.repoMapMd.slice(0, 8000)}
        </pre>
      </div>
    );
  }

  return (
    <p className="text-sm text-[var(--color-muted)]">
      {repo.status === 'ready'
        ? '暂无项目摘要，索引完成后会自动生成。'
        : '仓库索引中，完成后将显示项目摘要…'}
    </p>
  );
}

export function Repos(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<RepoTab>('summary');
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(selectedId);
  const [url, setUrl] = useState('');
  const [git, setGit] = useState<GitStatus | null>(null);
  const { active } = useJobProgress();
  const cloneJob = useJobFeedback('克隆并索引仓库');
  const toast = useToast();
  const cloneWasRunning = useRef(false);

  useEffect(() => {
    // 失败提示由 App 统一弹出，这里只补一条成功提示
    if (cloneWasRunning.current && !cloneJob.isRunning && !cloneJob.error && cloneJob.message) {
      toast(cloneJob.message, { variant: 'success' });
    }
    cloneWasRunning.current = cloneJob.isRunning;
  }, [cloneJob.isRunning, cloneJob.error, cloneJob.message, toast]);

  useEffect(() => {
    void invoke('repo:gitStatus', undefined).then(setGit);
  }, []);

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

  // 切换仓库时渲染期同步重置标签页
  if (prevSelectedId !== selectedId) {
    setPrevSelectedId(selectedId);
    setSelectedTab('summary');
  }

  const add = async (): Promise<void> => {
    const trimmed = url.trim();
    if (!trimmed || cloneJob.isRunning) return;
    try {
      await invoke('repo:add', { url: trimmed });
      setUrl('');
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = (id: string): void => {
    if (!confirm('确定删除该仓库及本地 clone？')) return;
    void runTask(`repo:delete:${id}`, () => invoke('repo:delete', { id }))
      .then(() => {
        if (selectedId === id) setSelectedId(null);
        refresh();
      })
      .catch(() => undefined);
  };

  const selected = repos.find((r) => r.id === selectedId) ?? null;
  const cloneBusy = cloneJob.isRunning;

  return (
    <PageShell fill className="gap-4 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
        <header>
          <h2 className="text-lg font-semibold">源码仓库</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Clone 后自动建 repo map 与项目摘要，供代码 Agent 问答
          </p>
        </header>

        {git && !git.available && (
          <div className="rounded border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-300">
            {git.hint}
          </div>
        )}

        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/..."
            disabled={git !== null && !git.available}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={cloneBusy || !url.trim() || (git !== null && !git.available)}
            className="shrink-0 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {cloneBusy ? '克隆中…' : '添加'}
          </button>
        </div>

        {cloneJob.isRunning && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
            <div className="font-medium">{cloneJob.statusMessage ?? '克隆并索引中…'}</div>
            {cloneJob.progress != null && (
              <div className="mt-2 h-1.5 rounded-full bg-[var(--color-border)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)]"
                  style={{ width: `${Math.round(cloneJob.progress * 100)}%` }}
                />
              </div>
            )}
          </div>
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
                <TaskButton
                  taskKey={`repo:delete:${r.id}`}
                  onClick={() => remove(r.id)}
                  runningLabel="删除中…"
                  className="mt-1 text-xs text-[var(--color-muted)] hover:text-red-400 disabled:opacity-50"
                >
                  删除
                </TaskButton>
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
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {REPO_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedTab(t.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    selectedTab === t.id
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {selectedTab === 'summary' ? (
                <div className="h-full overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <RepoSummaryPanel repo={selected} />
                </div>
              ) : (
                <RepoWorkspace repo={selected} />
              )}
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}