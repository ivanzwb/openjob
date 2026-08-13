import { useCallback, useEffect, useState } from 'react';
import type { SpeechSnippetView } from '@shared/ipc';
import { MarkdownContent } from '../components/MarkdownContent';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { PageShell } from '../components/PageShell';
import { TaskButton } from '../components/TaskButton';

type PanelMode = 'preview' | 'edit';

export function Scripts(): React.JSX.Element {
  const [snippets, setSnippets] = useState<SpeechSnippetView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [panelMode, setPanelMode] = useState<PanelMode>('preview');
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void invoke('speech:list', undefined).then((list) => {
      setSnippets(list);
      setSelectedId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        const first = list[0];
        if (first) {
          setDraft(first.contentMd);
          setPanelMode('preview');
        }
        return first?.id ?? null;
      });
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected = snippets.find((s) => s.id === selectedId) ?? null;
  const dirty = Boolean(selected && draft !== selected.contentMd);

  const pick = (s: SpeechSnippetView): void => {
    if (dirty && selected && selected.id !== s.id) {
      if (!confirm('有未保存的修改，切换将放弃编辑。继续？')) return;
    }
    setSelectedId(s.id);
    setDraft(s.contentMd);
    setPanelMode('preview');
  };

  const switchMode = (mode: PanelMode): void => {
    if (mode === 'preview' && dirty) {
      if (!confirm('有未保存的修改，切换预览将放弃编辑。继续？')) return;
      if (selected) setDraft(selected.contentMd);
    }
    setPanelMode(mode);
  };

  // 保存与导出都按 key 记：切到别的页面再回来，进行中的状态还在
  const saveKey = `speech:update:${selected?.id ?? 'none'}`;
  const { running: saving } = useTask(saveKey);

  useTaskResult(saveKey, () => {
    refresh();
    setPanelMode('preview');
  });

  const save = (): void => {
    if (!selected) return;
    const payload = { id: selected.id, contentMd: draft };
    void runTask(saveKey, () => invoke('speech:update', payload)).catch(() => undefined);
  };

  const remove = (id: string): void => {
    if (!confirm('确定删除这条话术？')) return;
    void runTask(`speech:delete:${id}`, () => invoke('speech:delete', { id }))
      .then(() => refresh())
      .catch(() => undefined);
  };

  const exportSnippets = (format: 'markdown' | 'anki' | 'pdf'): void => {
    setExportMsg(null);
    void runTask(`speech:export:${format}`, async () => {
      const res = await invoke('speech:export', { format });
      if (res.saved && res.path) return `已导出 ${res.count} 条到 ${res.path}`;
      if (!res.saved && res.count === 0) return '没有可导出的话术';
      return '';
    })
      .then((msg) => {
        if (msg) setExportMsg(msg);
      })
      .catch((e: unknown) => setExportMsg(e instanceof Error ? e.message : String(e)));
  };

  return (
    <PageShell fill className="gap-4 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-72">
        <header>
          <h2 className="text-lg font-semibold">话术库</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            考点讲解、考我反馈、源码问答的口语素材汇总。改写成你自己的话再背。
          </p>
        </header>

        <div className="flex flex-wrap gap-2">
          {(
            [
              ['markdown', '导出 Markdown'],
              ['anki', '导出 Anki'],
              ['pdf', '导出 PDF'],
            ] as const
          ).map(([format, label]) => (
            <TaskButton
              key={format}
              taskKey={`speech:export:${format}`}
              onClick={() => exportSnippets(format)}
              runningLabel="导出中…"
              className="rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50"
            >
              {label}
            </TaskButton>
          ))}
        </div>
        {exportMsg && <p className="text-xs text-emerald-400">{exportMsg}</p>}

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {snippets.length === 0 ? (
            <li className="text-sm text-[var(--color-muted)]">还没有话术，完成考我或源码问答后可沉淀</li>
          ) : (
            snippets.map((s) => (
              <li key={s.id} className="flex gap-2">
                <button
                  type="button"
                  onClick={() => pick(s)}
                  className={`min-w-0 flex-1 rounded-lg border p-3 text-left text-sm ${
                    selectedId === s.id
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                  }`}
                >
                  <div className="truncate font-medium">{s.sourceLabel}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-[var(--color-muted)]">
                    {s.contentMd.slice(0, 80)}
                  </div>
                </button>
                <TaskButton
                  taskKey={`speech:delete:${s.id}`}
                  onClick={() => remove(s.id)}
                  runningLabel="删除中"
                  title="删除这条话术"
                  className="flex w-11 shrink-0 items-center justify-center self-stretch rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-red-400 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                >
                  删除
                </TaskButton>
              </li>
            ))
          )}
        </ul>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-muted)]">
            选择一条话术编辑
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {(['preview', 'edit'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => switchMode(mode)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    panelMode === mode
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {mode === 'preview' ? '预览' : '编辑'}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{selected.sourceLabel}</h3>
              {panelMode === 'edit' && (
                <button
                  type="button"
                  disabled={saving || !dirty}
                  onClick={save}
                  className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs disabled:opacity-40"
                >
                  {saving ? '保存中…' : selected.isUserEdited ? '保存修改' : '保存为自己的话'}
                </button>
              )}
            </div>
            {panelMode === 'preview' ? (
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <MarkdownContent text={selected.contentMd} />
              </div>
            ) : (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={16}
                className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
              />
            )}
          </>
        )}
      </section>
    </PageShell>
  );
}
