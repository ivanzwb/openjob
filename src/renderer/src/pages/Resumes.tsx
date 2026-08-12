import { useCallback, useEffect, useState } from 'react';
import type { JobTarget, Resume } from '@shared/entities';
import type { ResumeVariantView } from '@shared/ipc';
import { RESUME_PDF_TEMPLATE_LABELS, RESUME_PDF_TEMPLATES } from '@shared/resume/templates';
import { MarkdownContent } from '../components/MarkdownContent';
import { PageShell } from '../components/PageShell';
import { invoke } from '../ipc';

type SubTab = 'targets' | 'resumes' | 'variants';

export function Resumes(): React.JSX.Element {
  const [tab, setTab] = useState<SubTab>('targets');
  const [targets, setTargets] = useState<JobTarget[]>([]);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [variants, setVariants] = useState<ResumeVariantView[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [targetForm, setTargetForm] = useState({ id: '', company: '', roleTitle: '', jdRaw: '' });
  const [resumeForm, setResumeForm] = useState({ id: '', label: '', rawText: '' });
  const [optimizeResumeId, setOptimizeResumeId] = useState('');
  const [optimizeTargetId, setOptimizeTargetId] = useState('');
  const [variantDraft, setVariantDraft] = useState('');
  const [exportTemplate, setExportTemplate] = useState<'classic' | 'modern' | 'compact'>('classic');

  const selectedVariant = variants.find((v) => v.id === selectedVariantId) ?? null;

  const refreshAll = useCallback(async () => {
    const [t, r, v] = await Promise.all([
      invoke('jobTarget:list', undefined),
      invoke('resume:list', undefined),
      invoke('resumeVariant:list', undefined),
    ]);
    setTargets(t);
    setResumes(r);
    setVariants(v);
    if (!optimizeResumeId && r[0]) setOptimizeResumeId(r[0].id);
    if (!optimizeTargetId && t[0]) setOptimizeTargetId(t[0].id);
  }, [optimizeResumeId, optimizeTargetId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (selectedVariant) setVariantDraft(selectedVariant.contentMd);
  }, [selectedVariant?.id, selectedVariant?.contentMd]);

  const saveTarget = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (targetForm.id) {
        await invoke('jobTarget:update', {
          id: targetForm.id,
          company: targetForm.company,
          roleTitle: targetForm.roleTitle,
          jdRaw: targetForm.jdRaw,
        });
      } else {
        await invoke('jobTarget:create', {
          company: targetForm.company,
          roleTitle: targetForm.roleTitle,
          jdRaw: targetForm.jdRaw,
        });
      }
      setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
      await refreshAll();
      setMessage('目标岗位已保存');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const editTarget = (t: JobTarget): void => {
    setTargetForm({
      id: t.id,
      company: t.company,
      roleTitle: t.roleTitle,
      jdRaw: t.jdRaw,
    });
    setTab('targets');
  };

  const saveResume = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (resumeForm.id) {
        await invoke('resume:update', {
          id: resumeForm.id,
          label: resumeForm.label,
          rawText: resumeForm.rawText,
        });
      } else {
        await invoke('resume:create', { label: resumeForm.label, rawText: resumeForm.rawText });
      }
      setResumeForm({ id: '', label: '', rawText: '' });
      await refreshAll();
      setMessage('简历已保存');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importResume = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await invoke('resume:importFile', undefined);
      if (r) {
        await refreshAll();
        setMessage(`已导入：${r.label}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const runOptimize = async (): Promise<void> => {
    if (!optimizeResumeId || !optimizeTargetId) return;
    setBusy(true);
    setMessage(null);
    try {
      const v = await invoke('resumeVariant:optimize', {
        sourceResumeId: optimizeResumeId,
        jobTargetId: optimizeTargetId,
      });
      await refreshAll();
      setSelectedVariantId(v.id);
      setTab('variants');
      setMessage('优化完成');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveVariant = async (): Promise<void> => {
    if (!selectedVariant) return;
    setBusy(true);
    try {
      await invoke('resumeVariant:update', {
        id: selectedVariant.id,
        contentMd: variantDraft,
      });
      await refreshAll();
      setMessage('优化版已保存');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async (): Promise<void> => {
    if (!selectedVariant) return;
    const res = await invoke('resumeVariant:exportPdf', {
      id: selectedVariant.id,
      template: exportTemplate,
    });
    setMessage(res.saved ? `已导出：${res.path}` : '已取消导出');
  };

  const deleteTarget = async (id: string): Promise<void> => {
    if (!confirm('确定删除此目标岗位？')) return;
    setBusy(true);
    setMessage(null);
    try {
      await invoke('jobTarget:delete', { id });
      if (targetForm.id === id) setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
      await refreshAll();
      setMessage('目标岗位已删除');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteResume = async (id: string): Promise<void> => {
    if (!confirm('确定删除此简历？关联的优化版也会一并删除。')) return;
    setBusy(true);
    setMessage(null);
    try {
      await invoke('resume:delete', { id });
      if (resumeForm.id === id) setResumeForm({ id: '', label: '', rawText: '' });
      await refreshAll();
      setMessage('简历已删除');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteVariant = async (id: string): Promise<void> => {
    if (!confirm('确定删除此优化版？')) return;
    setBusy(true);
    setMessage(null);
    try {
      await invoke('resumeVariant:delete', { id });
      if (selectedVariantId === id) setSelectedVariantId(null);
      await refreshAll();
      setMessage('优化版已删除');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell className="flex h-full min-h-0 flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">简历</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          管理目标岗位与母版简历，生成针对岗位的优化版并导出 PDF
        </p>
      </header>

      <nav className="flex gap-2">
        {(
          [
            ['targets', '目标岗位'],
            ['resumes', '我的简历'],
            ['variants', '优化版本'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === key
                ? 'bg-[var(--color-surface)] text-[var(--color-fg)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {message && <p className="text-xs text-[var(--color-muted)]">{message}</p>}

      {tab === 'targets' && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
            <h3 className="text-sm font-medium">
              {targetForm.id ? '编辑目标岗位' : '新建目标岗位'}
            </h3>
            <input
              value={targetForm.company}
              onChange={(e) => setTargetForm((f) => ({ ...f, company: e.target.value }))}
              placeholder="公司"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
            <input
              value={targetForm.roleTitle}
              onChange={(e) => setTargetForm((f) => ({ ...f, roleTitle: e.target.value }))}
              placeholder="岗位"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
            <textarea
              value={targetForm.jdRaw}
              onChange={(e) => setTargetForm((f) => ({ ...f, jdRaw: e.target.value }))}
              placeholder="岗位 JD"
              rows={10}
              className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveTarget()}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
              >
                保存
              </button>
              {targetForm.id && (
                <button
                  type="button"
                  onClick={() => setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' })}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                >
                  取消编辑
                </button>
              )}
            </div>
          </div>
          <div className="space-y-2 overflow-y-auto">
            {targets.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-[var(--color-border)] p-3 text-sm"
              >
                <div className="font-medium">{t.company} · {t.roleTitle}</div>
                <p className="mt-1 line-clamp-3 text-xs text-[var(--color-muted)]">{t.jdRaw}</p>
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    onClick={() => editTarget(t)}
                    className="text-xs text-[var(--color-accent)]"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteTarget(t.id)}
                    className="text-xs text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'resumes' && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
            <h3 className="text-sm font-medium">{resumeForm.id ? '编辑简历' : '新建简历'}</h3>
            <input
              value={resumeForm.label}
              onChange={(e) => setResumeForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="名称"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
            <textarea
              value={resumeForm.rawText}
              onChange={(e) => setResumeForm((f) => ({ ...f, rawText: e.target.value }))}
              placeholder="简历正文"
              rows={12}
              className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveResume()}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => void importResume()}
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
              >
                导入文件
              </button>
            </div>
            <div className="border-t border-[var(--color-border)] pt-3 space-y-2">
              <h4 className="text-xs font-medium text-[var(--color-muted)]">定向优化</h4>
              <select
                value={optimizeResumeId}
                onChange={(e) => setOptimizeResumeId(e.target.value)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              >
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
              <select
                value={optimizeTargetId}
                onChange={(e) => setOptimizeTargetId(e.target.value)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.company} · {t.roleTitle}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !optimizeResumeId || !optimizeTargetId}
                onClick={() => void runOptimize()}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
              >
                生成优化版
              </button>
            </div>
          </div>
          <div className="space-y-2 overflow-y-auto">
            {resumes.map((r) => (
              <div key={r.id} className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-sm font-medium">{r.label}</div>
                <div className="mt-1 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setResumeForm({ id: r.id, label: r.label, rawText: r.rawText })}
                    className="text-xs text-[var(--color-accent)]"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteResume(r.id)}
                    className="text-xs text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'variants' && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[220px_1fr]">
          <div className="space-y-2 overflow-y-auto">
            {variants.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelectedVariantId(v.id)}
                className={`w-full rounded-lg border p-3 text-left text-sm ${
                  selectedVariantId === v.id
                    ? 'border-[var(--color-accent)]'
                    : 'border-[var(--color-border)]'
                }`}
              >
                <div className="font-medium">{v.label}</div>
                <div className="text-xs text-[var(--color-muted)]">母版：{v.sourceResumeLabel}</div>
              </button>
            ))}
          </div>
          {selectedVariant ? (
            <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
              <div className="text-sm">
                <span className="font-medium">{selectedVariant.company} · {selectedVariant.roleTitle}</span>
                {selectedVariant.isUserEdited && (
                  <span className="ml-2 text-xs text-amber-500">已手动编辑</span>
                )}
              </div>
              <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
                <div className="overflow-y-auto rounded-lg border border-[var(--color-border)] p-3">
                  <h4 className="mb-2 text-xs text-[var(--color-muted)]">原文（母版）</h4>
                  <pre className="whitespace-pre-wrap text-xs">{selectedVariant.sourceResumeText}</pre>
                </div>
                <div className="flex min-h-0 flex-col gap-2">
                  <h4 className="text-xs text-[var(--color-muted)]">优化版（可编辑）</h4>
                  <textarea
                    value={variantDraft}
                    onChange={(e) => setVariantDraft(e.target.value)}
                    className="min-h-[200px] flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs"
                  />
                  {selectedVariant.changelogMd && (
                    <div className="rounded border border-[var(--color-border)] p-2 text-xs">
                      <div className="mb-1 font-medium text-[var(--color-muted)]">改动说明</div>
                      <MarkdownContent text={selectedVariant.changelogMd} />
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveVariant()}
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm"
                >
                  保存修改
                </button>
                <select
                  value={exportTemplate}
                  onChange={(e) => setExportTemplate(e.target.value as typeof exportTemplate)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                >
                  {RESUME_PDF_TEMPLATES.map((t) => (
                    <option key={t} value={t}>{RESUME_PDF_TEMPLATE_LABELS[t]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void exportPdf()}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                >
                  导出 PDF
                </button>
                <button
                  type="button"
                  onClick={() => void deleteVariant(selectedVariant.id)}
                  className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-400"
                >
                  删除
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">选择左侧优化版，或从「我的简历」生成</p>
          )}
        </div>
      )}
    </PageShell>
  );
}
