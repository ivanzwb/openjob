import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobTarget, Resume } from '@shared/entities';
import type { ResumeVariantView } from '@shared/ipc';
import { RESUME_PDF_TEMPLATE_LABELS, RESUME_PDF_TEMPLATES } from '@shared/resume/templates';
import { PageShell } from '../components/PageShell';
import { invoke } from '../ipc';

type SubTab = 'targets' | 'resumes';

type ListSelection =
  | { kind: 'resume'; id: string }
  | { kind: 'variant'; id: string };

type SidebarEntry =
  | {
      kind: 'resume';
      id: string;
      label: string;
      subtitle: string;
      updatedAt: number;
    }
  | {
      kind: 'variant';
      id: string;
      label: string;
      subtitle: string;
      updatedAt: number;
      variant: ResumeVariantView;
    };

export function Resumes(): React.JSX.Element {
  const [tab, setTab] = useState<SubTab>('targets');
  const [targets, setTargets] = useState<JobTarget[]>([]);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [variants, setVariants] = useState<ResumeVariantView[]>([]);
  const [listSelection, setListSelection] = useState<ListSelection | null>(null);
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [targetForm, setTargetForm] = useState({ id: '', company: '', roleTitle: '', jdRaw: '' });
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [targetFormOpen, setTargetFormOpen] = useState(false);
  const [resumeForm, setResumeForm] = useState({ id: '', label: '', rawText: '' });
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [resumeFormOpen, setResumeFormOpen] = useState(false);
  const [optimizeTargetId, setOptimizeTargetId] = useState('');
  const [variantDraft, setVariantDraft] = useState('');
  const [exportTemplate, setExportTemplate] = useState<'classic' | 'modern' | 'compact'>('classic');

  const selectedTarget = targets.find((t) => t.id === selectedTargetId) ?? null;
  const selectedResume = resumes.find((r) => r.id === selectedResumeId) ?? null;
  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? null;

  const sidebarEntries = useMemo((): SidebarEntry[] => {
    const items: SidebarEntry[] = resumes.map((r) => ({
      kind: 'resume',
      id: r.id,
      label: r.label,
      subtitle: '母版',
      updatedAt: r.updatedAt,
    }));
    for (const v of variants) {
      items.push({
        kind: 'variant',
        id: v.id,
        label: `${v.company} · ${v.roleTitle}`,
        subtitle: `来自 ${v.sourceResumeLabel}`,
        updatedAt: v.updatedAt,
        variant: v,
      });
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [resumes, variants]);

  const isEntrySelected = (entry: SidebarEntry): boolean =>
    listSelection?.kind === entry.kind && listSelection.id === entry.id;

  const refreshAll = useCallback(async () => {
    const [t, r, v] = await Promise.all([
      invoke('jobTarget:list', undefined),
      invoke('resume:list', undefined),
      invoke('resumeVariant:list', undefined),
    ]);
    setTargets(t);
    setResumes(r);
    setVariants(v);
    setSelectedTargetId((prev) => {
      if (prev && t.some((x) => x.id === prev)) return prev;
      return t[0]?.id ?? null;
    });
    setSelectedResumeId((prev) => {
      if (prev && r.some((x) => x.id === prev)) return prev;
      return r[0]?.id ?? null;
    });
    setListSelection((prev) => {
      if (prev?.kind === 'resume' && r.some((x) => x.id === prev.id)) return prev;
      if (prev?.kind === 'variant' && v.some((x) => x.id === prev.id)) return prev;
      if (r[0]) return { kind: 'resume', id: r[0].id };
      return null;
    });
    if (!optimizeTargetId && t[0]) setOptimizeTargetId(t[0].id);
  }, [optimizeTargetId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedResume || resumeFormOpen || listSelection?.kind === 'variant') return;
    const match = variants.find(
      (v) => v.sourceResumeId === selectedResume.id && v.jobTargetId === optimizeTargetId,
    );
    if (match) {
      setActiveVariantId(match.id);
      setVariantDraft(match.contentMd);
    } else {
      setActiveVariantId(null);
      setVariantDraft('');
    }
  }, [selectedResume?.id, optimizeTargetId, variants, resumeFormOpen, listSelection?.kind]);

  const saveTarget = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      let saved: JobTarget;
      if (targetForm.id) {
        saved = await invoke('jobTarget:update', {
          id: targetForm.id,
          company: targetForm.company,
          roleTitle: targetForm.roleTitle,
          jdRaw: targetForm.jdRaw,
        });
      } else {
        saved = await invoke('jobTarget:create', {
          company: targetForm.company,
          roleTitle: targetForm.roleTitle,
          jdRaw: targetForm.jdRaw,
        });
      }
      setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
      setTargetFormOpen(false);
      setSelectedTargetId(saved.id);
      await refreshAll();
      setMessage('目标岗位已保存');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openNewTargetForm = (): void => {
    setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
    setTargetFormOpen(true);
    setTab('targets');
  };

  const closeTargetForm = (): void => {
    setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
    setTargetFormOpen(false);
  };

  const editTarget = (t: JobTarget): void => {
    setTargetForm({
      id: t.id,
      company: t.company,
      roleTitle: t.roleTitle,
      jdRaw: t.jdRaw,
    });
    setSelectedTargetId(t.id);
    setTargetFormOpen(true);
    setTab('targets');
  };

  const selectTarget = (id: string): void => {
    setSelectedTargetId(id);
    setTargetFormOpen(false);
    setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
  };

  const saveResume = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      let saved: Resume;
      if (resumeForm.id) {
        saved = await invoke('resume:update', {
          id: resumeForm.id,
          label: resumeForm.label,
          rawText: resumeForm.rawText,
        });
      } else {
        saved = await invoke('resume:create', { label: resumeForm.label, rawText: resumeForm.rawText });
      }
      setResumeForm({ id: '', label: '', rawText: '' });
      setResumeFormOpen(false);
      setSelectedResumeId(saved.id);
      setListSelection({ kind: 'resume', id: saved.id });
      await refreshAll();
      setMessage('简历已保存');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openNewResumeForm = (): void => {
    setResumeForm({ id: '', label: '', rawText: '' });
    setResumeFormOpen(true);
    setTab('resumes');
  };

  const closeResumeForm = (): void => {
    setResumeForm({ id: '', label: '', rawText: '' });
    setResumeFormOpen(false);
  };

  const editResume = (r: Resume): void => {
    setResumeForm({ id: r.id, label: r.label, rawText: r.rawText });
    setSelectedResumeId(r.id);
    setResumeFormOpen(true);
    setTab('resumes');
  };

  const selectMasterResume = (id: string): void => {
    setListSelection({ kind: 'resume', id });
    setSelectedResumeId(id);
    setResumeFormOpen(false);
    setResumeForm({ id: '', label: '', rawText: '' });
  };

  const selectVariantEntry = (v: ResumeVariantView): void => {
    setListSelection({ kind: 'variant', id: v.id });
    setSelectedResumeId(v.sourceResumeId);
    setActiveVariantId(v.id);
    setOptimizeTargetId(v.jobTargetId);
    setVariantDraft(v.contentMd);
    setResumeFormOpen(false);
    setResumeForm({ id: '', label: '', rawText: '' });
  };

  const selectSidebarEntry = (entry: SidebarEntry): void => {
    if (entry.kind === 'resume') selectMasterResume(entry.id);
    else selectVariantEntry(entry.variant);
  };

  const importResume = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke('resume:importFile', undefined);
      if (r) {
        setSelectedResumeId(r.id);
        setListSelection({ kind: 'resume', id: r.id });
        setResumeFormOpen(false);
        setResumeForm({ id: '', label: '', rawText: '' });
        await refreshAll();
        setMessage(`已导入：${r.label}`);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runOptimize = async (): Promise<void> => {
    if (!selectedResumeId || !optimizeTargetId) return;
    setBusy(true);
    setMessage(null);
    try {
      const v = await invoke('resumeVariant:optimize', {
        sourceResumeId: selectedResumeId,
        jobTargetId: optimizeTargetId,
      });
      setListSelection({ kind: 'variant', id: v.id });
      setActiveVariantId(v.id);
      setVariantDraft(v.contentMd);
      await refreshAll();
      setMessage('优化完成');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveVariant = async (): Promise<void> => {
    if (!activeVariantId) return;
    setBusy(true);
    setMessage(null);
    try {
      await invoke('resumeVariant:update', {
        id: activeVariantId,
        contentMd: variantDraft,
      });
      setListSelection({ kind: 'variant', id: activeVariantId });
      await refreshAll();
      setMessage('优化版已保存');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async (): Promise<void> => {
    if (!activeVariantId) return;
    const res = await invoke('resumeVariant:exportPdf', {
      id: activeVariantId,
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
      if (targetForm.id === id) closeTargetForm();
      if (selectedTargetId === id) setSelectedTargetId(null);
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
      if (resumeForm.id === id) closeResumeForm();
      if (selectedResumeId === id) {
        setSelectedResumeId(null);
        setListSelection(null);
      }
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
      if (activeVariantId === id) {
        setActiveVariantId(null);
        setVariantDraft('');
      }
      if (listSelection?.kind === 'variant' && listSelection.id === id) {
        if (selectedResumeId) setListSelection({ kind: 'resume', id: selectedResumeId });
        else setListSelection(null);
      }
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
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_1fr]">
          <div className="flex min-h-0 flex-col rounded-lg border border-[var(--color-border)]">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
              <span className="text-sm font-medium">岗位列表</span>
              <button
                type="button"
                onClick={openNewTargetForm}
                className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium"
              >
                新建岗位
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
              {targets.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--color-muted)]">暂无岗位，点击「新建岗位」</p>
              ) : (
                targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTarget(t.id)}
                    className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                      selectedTargetId === t.id
                        ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                        : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]/50'
                    }`}
                  >
                    <div className="font-medium">{t.company}</div>
                    <div className="text-xs text-[var(--color-muted)]">{t.roleTitle}</div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)]">
            {targetFormOpen ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold">
                      {targetForm.id
                        ? `${targetForm.company || '…'} · ${targetForm.roleTitle || '…'}`
                        : '新建目标岗位'}
                    </h3>
                    {targetForm.id && (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">编辑中</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveTarget()}
                      className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={closeTargetForm}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                    >
                      取消
                    </button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                  <div className="grid shrink-0 gap-3 sm:grid-cols-2">
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
                  </div>
                  <textarea
                    value={targetForm.jdRaw}
                    onChange={(e) => setTargetForm((f) => ({ ...f, jdRaw: e.target.value }))}
                    placeholder="岗位 JD"
                    className="min-h-0 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed"
                  />
                </div>
              </div>
            ) : selectedTarget ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold">
                      {selectedTarget.company} · {selectedTarget.roleTitle}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      更新于 {new Date(selectedTarget.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => editTarget(selectedTarget)}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteTarget(selectedTarget.id)}
                      className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-400"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <h4 className="mb-2 text-xs font-medium text-[var(--color-muted)]">岗位 JD</h4>
                  <pre className="whitespace-pre-wrap text-sm leading-relaxed">{selectedTarget.jdRaw}</pre>
                </div>
              </div>
            ) : (
              <p className="p-4 text-sm text-[var(--color-muted)]">
                从左侧选择岗位，或点击「新建岗位」添加
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'resumes' && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_1fr]">
          <div className="flex min-h-0 flex-col rounded-lg border border-[var(--color-border)]">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
              <span className="text-sm font-medium">简历列表</span>
              <button
                type="button"
                onClick={openNewResumeForm}
                className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium"
              >
                新建简历
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
              {sidebarEntries.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--color-muted)]">暂无简历，点击「新建简历」</p>
              ) : (
                sidebarEntries.map((entry) => (
                  <button
                    key={`${entry.kind}-${entry.id}`}
                    type="button"
                    onClick={() => selectSidebarEntry(entry)}
                    className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                      isEntrySelected(entry)
                        ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                        : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]/50'
                    }`}
                  >
                    <div className="font-medium">{entry.label}</div>
                    <div className="text-xs text-[var(--color-muted)]">{entry.subtitle}</div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)]">
            {resumeFormOpen ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold">
                      {resumeForm.id ? resumeForm.label || '…' : '新建简历'}
                    </h3>
                    {resumeForm.id && (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">编辑中</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveResume()}
                      className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={closeResumeForm}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importResume()}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                    >
                      导入文件
                    </button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                  <input
                    value={resumeForm.label}
                    onChange={(e) => setResumeForm((f) => ({ ...f, label: e.target.value }))}
                    placeholder="名称"
                    className="shrink-0 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                  />
                  <textarea
                    value={resumeForm.rawText}
                    onChange={(e) => setResumeForm((f) => ({ ...f, rawText: e.target.value }))}
                    placeholder="简历正文"
                    className="min-h-0 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed"
                  />
                </div>
              </div>
            ) : selectedResume ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold">
                      {listSelection?.kind === 'variant' && activeVariant
                        ? `${activeVariant.company} · ${activeVariant.roleTitle}`
                        : selectedResume.label}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      {listSelection?.kind === 'variant' && activeVariant
                        ? `来自 ${activeVariant.sourceResumeLabel}`
                        : `更新于 ${new Date(selectedResume.updatedAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      disabled={busy || !activeVariantId}
                      onClick={() => void saveVariant()}
                      className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      保存
                    </button>
                    {activeVariantId && (
                      <>
                        <select
                          value={exportTemplate}
                          onChange={(e) => setExportTemplate(e.target.value as typeof exportTemplate)}
                          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
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
                      </>
                    )}
                    {listSelection?.kind === 'variant' && activeVariant ? (
                      <button
                        type="button"
                        onClick={() => void deleteVariant(activeVariant.id)}
                        className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-400"
                      >
                        删除
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => editResume(selectedResume)}
                          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteResume(selectedResume.id)}
                          className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-400"
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void importResume()}
                          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                        >
                          导入文件
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
                  <span className="text-xs text-[var(--color-muted)]">目标岗位</span>
                  <select
                    value={optimizeTargetId}
                    disabled={listSelection?.kind === 'variant'}
                    onChange={(e) => setOptimizeTargetId(e.target.value)}
                    className="min-w-[200px] rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm disabled:opacity-60"
                  >
                    {targets.length === 0 && <option value="">暂无目标岗位</option>}
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>{t.company} · {t.roleTitle}</option>
                    ))}
                  </select>
                  {listSelection?.kind !== 'variant' && (
                    <button
                      type="button"
                      disabled={busy || !optimizeTargetId || targets.length === 0}
                      onClick={() => void runOptimize()}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      生成优化版
                    </button>
                  )}
                </div>
                <div className="grid min-h-0 flex-1 lg:grid-cols-2">
                  <div className="min-h-0 overflow-y-auto border-r border-[var(--color-border)] p-4">
                    <h4 className="mb-2 text-xs font-medium text-[var(--color-muted)]">母版简历</h4>
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                      {activeVariant?.sourceResumeText ?? selectedResume.rawText}
                    </pre>
                  </div>
                  <div className="flex min-h-0 flex-col p-4">
                    <h4 className="mb-2 shrink-0 text-xs font-medium text-[var(--color-muted)]">
                      优化版简历
                      {activeVariant?.isUserEdited && (
                        <span className="ml-2 text-amber-500">已手动编辑</span>
                      )}
                    </h4>
                    {activeVariantId ? (
                      <textarea
                        value={variantDraft}
                        onChange={(e) => setVariantDraft(e.target.value)}
                        className="min-h-0 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed"
                      />
                    ) : (
                      <p className="text-sm text-[var(--color-muted)]">
                        选择目标岗位并点击「生成优化版」，或从左侧列表选择已保存的优化版
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="p-4 text-sm text-[var(--color-muted)]">
                从左侧选择简历，或点击「新建简历」添加
              </p>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
