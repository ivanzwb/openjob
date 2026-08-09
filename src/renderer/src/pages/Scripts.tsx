import { useCallback, useEffect, useState } from 'react';
import type { SpeechSnippetView } from '@shared/ipc';
import { invoke } from '../ipc';

export function Scripts(): React.JSX.Element {
  const [snippets, setSnippets] = useState<SpeechSnippetView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void invoke('speech:list', undefined).then((list) => {
      setSnippets(list);
      setSelectedId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        const first = list[0];
        if (first) setDraft(first.contentMd);
        return first?.id ?? null;
      });
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected = snippets.find((s) => s.id === selectedId) ?? null;

  const save = async (): Promise<void> => {
    if (!selected) return;
    setSaving(true);
    try {
      await invoke('speech:update', { id: selected.id, contentMd: draft });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!confirm('确定删除这条话术？')) return;
    await invoke('speech:delete', { id });
    refresh();
  };

  const exportSnippets = async (format: 'markdown' | 'anki' | 'pdf'): Promise<void> => {
    setExportMsg(null);
    const res = await invoke('speech:export', { format });
    if (res.saved && res.path) {
      setExportMsg(`已导出 ${res.count} 条到 ${res.path}`);
    } else if (!res.saved && res.count === 0) {
      setExportMsg('没有可导出的话术');
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 p-6 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-72">
        <header>
          <h2 className="text-lg font-semibold">话术库</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            考点讲解、考我反馈、源码问答的口语素材汇总。改写成你自己的话再背。
          </p>
        </header>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void exportSnippets('markdown')}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
          >
            导出 Markdown
          </button>
          <button
            type="button"
            onClick={() => void exportSnippets('anki')}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
          >
            导出 Anki
          </button>
          <button
            type="button"
            onClick={() => void exportSnippets('pdf')}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
          >
            导出 PDF
          </button>
        </div>
        {exportMsg && <p className="text-xs text-emerald-400">{exportMsg}</p>}

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {snippets.length === 0 ? (
            <li className="text-sm text-[var(--color-muted)]">还没有话术，完成考我或源码问答后可沉淀</li>
          ) : (
            snippets.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(s.id);
                    setDraft(s.contentMd);
                  }}
                  className={`w-full rounded-lg border p-3 text-left text-sm ${
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
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{selected.sourceLabel}</h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void remove(selected.id)}
                  className="text-xs text-red-400 hover:underline"
                >
                  删除
                </button>
                <button
                  type="button"
                  disabled={saving || draft === selected.contentMd}
                  onClick={() => void save()}
                  className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs disabled:opacity-40"
                >
                  {saving ? '保存中…' : selected.isUserEdited ? '保存修改' : '保存为自己的话'}
                </button>
              </div>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={16}
              className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />
          </>
        )}
      </section>
    </div>
  );
}
