import { useCallback, useEffect, useState } from 'react';
import type { CampaignSummary } from '@shared/ipc';
import type { Resume } from '@shared/entities';
import { invoke } from '../ipc';
import { PageShell } from '../components/PageShell';

export function CampaignList({
  onOpen,
  onCreate,
}: {
  onOpen: (id: string) => void;
  onCreate: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [resumeLabel, setResumeLabel] = useState('我的简历');
  const [resumeText, setResumeText] = useState('');
  const [showResumeForm, setShowResumeForm] = useState(false);
  const [importingResume, setImportingResume] = useState(false);

  const refresh = useCallback(() => {
    void invoke('campaign:list', undefined).then(setItems);
  }, []);

  const refreshResumes = useCallback(() => {
    void invoke('resume:list', undefined).then(setResumes);
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

  useEffect(() => {
    refreshResumes();
  }, [refreshResumes]);

  const remove = async (id: string): Promise<void> => {
    if (!confirm('确定删除这场备考？')) return;
    await invoke('campaign:delete', { id });
    refresh();
  };

  const importResumeFile = async (): Promise<void> => {
    setImportingResume(true);
    try {
      const r = await invoke('resume:importFile', undefined);
      if (r) refreshResumes();
    } finally {
      setImportingResume(false);
    }
  };

  const createResume = async (): Promise<void> => {
    if (!resumeText.trim()) return;
    await invoke('resume:create', {
      label: resumeLabel.trim() || '我的简历',
      rawText: resumeText.trim(),
    });
    setShowResumeForm(false);
    setResumeText('');
    refreshResumes();
  };

  const removeResume = async (id: string): Promise<void> => {
    if (!confirm('确定删除这份简历？已关联的战役会失去交叉分析。')) return;
    await invoke('resume:delete', { id });
    refreshResumes();
  };

  return (
    <PageShell className="space-y-6">
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

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">简历库</h3>
          <button
            type="button"
            disabled={importingResume}
            onClick={() => void importResumeFile()}
            className="text-xs text-sky-400 hover:underline disabled:opacity-40"
          >
            {importingResume ? '导入中…' : '从文件导入 (PDF / DOCX)'}
          </button>
        </div>
        {resumes.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            还没有简历。导入或粘贴一份，之后可跨战役复用同一份简历。
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {resumes.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="shrink-0 text-xs text-[var(--color-muted)]">
                  {r.rawText.length} 字
                </span>
                <button
                  type="button"
                  onClick={() => void removeResume(r.id)}
                  className="shrink-0 text-xs text-[var(--color-muted)] hover:text-red-400"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
        {showResumeForm ? (
          <div className="mt-3 space-y-2">
            <input
              value={resumeLabel}
              onChange={(e) => setResumeLabel(e.target.value)}
              placeholder="简历名称"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
            />
            <textarea
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              rows={5}
              placeholder="粘贴简历全文…"
              className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
            />
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => void createResume()}
                className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs"
              >
                保存到简历库
              </button>
              <button
                type="button"
                onClick={() => setShowResumeForm(false)}
                className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowResumeForm((v) => !v)}
            className="mt-3 text-xs text-sky-400 hover:underline"
          >
            + 粘贴新简历
          </button>
        )}
      </section>

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
    </PageShell>
  );
}