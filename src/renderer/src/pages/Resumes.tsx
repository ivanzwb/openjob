import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobTarget, Resume } from '@shared/entities';
import type { ResumeVariantView } from '@shared/ipc';
import type { ResumeEditorSavePayload } from '../components/ResumeEditorPane';
import { ResumeEditorPane } from '../components/ResumeEditorPane';
import { PageShell } from '../components/PageShell';
import { TaskButton } from '../components/TaskButton';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

type SubTab = 'targets' | 'resumes';

const NEW_RESUME_DRAFT_ID = '__new_resume_draft__';

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
  const [message, setMessage] = useState<string | null>(null);

  const [targetForm, setTargetForm] = useState({ id: '', company: '', roleTitle: '', jdRaw: '' });
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [targetFormOpen, setTargetFormOpen] = useState(false);
  const [resumeForm, setResumeForm] = useState({ label: '', rawText: '' });
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [resumeFormOpen, setResumeFormOpen] = useState(false);
  const [optimizeTargetId, setOptimizeTargetId] = useState('');
  const [optimizeBaseResumeId, setOptimizeBaseResumeId] = useState('');

  const selectedTarget = targets.find((t) => t.id === selectedTargetId) ?? null;
  const selectedResume = resumes.find((r) => r.id === selectedResumeId) ?? null;
  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? null;

  // 母版与优化版共用同一套编辑器；新建草稿态不进编辑器
  const editorKind: 'resume' | 'variant' | null = resumeFormOpen
    ? null
    : listSelection?.kind === 'variant'
      ? 'variant'
      : listSelection?.kind === 'resume'
        ? 'resume'
        : null;
  const editorId =
    editorKind === 'variant' ? activeVariantId : editorKind === 'resume' ? selectedResumeId : null;

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
        subtitle: v.sourceResumeLabel ? `来自 ${v.sourceResumeLabel}` : '母版已删除',
        updatedAt: v.updatedAt,
        variant: v,
      });
    }
    const sorted = items.sort((a, b) => b.updatedAt - a.updatedAt);
    if (resumeFormOpen) {
      const target = targets.find((t) => t.id === optimizeTargetId);
      sorted.unshift({
        kind: 'resume',
        id: NEW_RESUME_DRAFT_ID,
        label: resumeForm.label.trim() || '新建简历',
        subtitle: target ? `${target.company} · ${target.roleTitle}` : '未保存',
        updatedAt: 0,
      });
    }
    return sorted;
  }, [resumes, variants, targets, resumeFormOpen, resumeForm.label, optimizeTargetId]);

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
      if (prev?.kind === 'resume' && prev.id === NEW_RESUME_DRAFT_ID) return prev;
      if (prev?.kind === 'resume' && r.some((x) => x.id === prev.id)) return prev;
      if (prev?.kind === 'variant' && v.some((x) => x.id === prev.id)) return prev;
      if (r[0]) return { kind: 'resume', id: r[0].id };
      return null;
    });
    if (!optimizeTargetId && t[0]) setOptimizeTargetId(t[0].id);
  }, [optimizeTargetId]);

  useEffect(() => {
    // refreshAll 为 async，所有 setState 均在 await 之后，非同步 setState，属规则误报
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll();
  }, [refreshAll]);

  // 切换母版/关闭表单时渲染期同步清空选中变体
  if (selectedResume && !resumeFormOpen && listSelection?.kind !== 'variant' && activeVariantId !== null) {
    setActiveVariantId(null);
  }

  // 这些动作都按 key 记在全局任务仓库里：切到别的页面再回来，
  // 还在跑的按钮仍然是「进行中」，跑完的结果也会补进界面
  const saveTargetKey = `jobTarget:save:${targetForm.id || 'new'}`;
  const createResumeKey = 'resume:create';
  const importResumeKey = 'resume:import';
  const optimizeKey = `resumeVariant:optimize:${optimizeBaseResumeId || 'new'}:${optimizeTargetId}`;
  const { running: savingTarget, error: saveTargetError } = useTask(saveTargetKey);
  const { running: creatingResume, error: createResumeError } = useTask(createResumeKey);
  const { running: importingResume, error: importResumeError } = useTask(importResumeKey);
  const { running: optimizing, error: optimizeError } = useTask(optimizeKey);

  // 任务失败原因留在仓库里，切页回来还能看到，所以直接读它而不复制进 state
  const taskFailure = saveTargetError ?? createResumeError ?? importResumeError ?? optimizeError;

  const saveTarget = (): void => {
    setMessage(null);
    const form = targetForm;
    void runTask(saveTargetKey, async () => {
      const saved: JobTarget = form.id
        ? await invoke('jobTarget:update', {
            id: form.id,
            company: form.company,
            roleTitle: form.roleTitle,
            jdRaw: form.jdRaw,
          })
        : await invoke('jobTarget:create', {
            company: form.company,
            roleTitle: form.roleTitle,
            jdRaw: form.jdRaw,
          });
      await refreshAll();
      return saved;
    }).catch(() => undefined);
  };

  useTaskResult<JobTarget>(saveTargetKey, (saved) => {
    setTargetForm({ id: '', company: '', roleTitle: '', jdRaw: '' });
    setTargetFormOpen(false);
    setSelectedTargetId(saved.id);
    setMessage('目标岗位已保存');
  });

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

  const saveResume = (): void => {
    setMessage(null);
    const form = resumeForm;
    void runTask(createResumeKey, async () => {
      const saved = await invoke('resume:create', { label: form.label, rawText: form.rawText });
      await refreshAll();
      return saved;
    }).catch(() => undefined);
  };

  useTaskResult<Resume>(createResumeKey, (saved) => {
    setResumeForm({ label: '', rawText: '' });
    setResumeFormOpen(false);
    setSelectedResumeId(saved.id);
    setListSelection({ kind: 'resume', id: saved.id });
    setMessage('简历已保存');
  });

  const openNewResumeForm = (): void => {
    setResumeForm({ label: '', rawText: '' });
    setResumeFormOpen(true);
    setListSelection({ kind: 'resume', id: NEW_RESUME_DRAFT_ID });
    setSelectedResumeId(null);
    setOptimizeBaseResumeId('');
    setTab('resumes');
  };

  const closeResumeForm = (): void => {
    setResumeForm({ label: '', rawText: '' });
    setResumeFormOpen(false);
    setListSelection(resumes[0] ? { kind: 'resume', id: resumes[0].id } : null);
    setSelectedResumeId(resumes[0]?.id ?? null);
  };

  const selectMasterResume = (id: string): void => {
    if (id === NEW_RESUME_DRAFT_ID) {
      setListSelection({ kind: 'resume', id: NEW_RESUME_DRAFT_ID });
      setSelectedResumeId(null);
      setResumeFormOpen(true);
      return;
    }
    setListSelection({ kind: 'resume', id });
    setSelectedResumeId(id);
    setResumeFormOpen(false);
    setResumeForm({ label: '', rawText: '' });
  };

  const selectVariantEntry = (v: ResumeVariantView): void => {
    setListSelection({ kind: 'variant', id: v.id });
    setSelectedResumeId(v.sourceResumeId);
    setActiveVariantId(v.id);
    setOptimizeTargetId(v.jobTargetId);
    setResumeFormOpen(false);
    setResumeForm({ label: '', rawText: '' });
  };

  const selectSidebarEntry = (entry: SidebarEntry): void => {
    if (entry.kind === 'resume') selectMasterResume(entry.id);
    else selectVariantEntry(entry.variant);
  };

  const importResume = (): void => {
    setMessage(null);
    void runTask(importResumeKey, async () => {
      const r = await invoke('resume:importFile', undefined);
      if (r) await refreshAll();
      return r;
    }).catch(() => undefined);
  };

  useTaskResult<Resume | null>(importResumeKey, (r) => {
    if (!r) return;
    setSelectedResumeId(r.id);
    setListSelection({ kind: 'resume', id: r.id });
    setResumeFormOpen(false);
    setResumeForm({ label: '', rawText: '' });
    setMessage(`已导入：${r.label}`);
  });

  const runOptimizeFromNewResume = (): void => {
    const baseFromList = optimizeBaseResumeId
      ? resumes.find((r) => r.id === optimizeBaseResumeId)
      : null;
    if (!baseFromList && !resumeForm.rawText.trim()) {
      setMessage('请先填写或导入母版简历正文，或选择已有 base 简历');
      return;
    }
    if (!optimizeTargetId || targets.length === 0) {
      setMessage('请选择目标岗位');
      return;
    }
    setMessage(null);
    const input = { baseId: baseFromList?.id ?? null, form: resumeForm, targetId: optimizeTargetId };
    void runTask(optimizeKey, async () => {
      const sourceResumeId =
        input.baseId ??
        (
          await invoke('resume:create', {
            label: input.form.label.trim() || '我的简历',
            rawText: input.form.rawText,
          })
        ).id;
      const variant = await invoke('resumeVariant:optimize', {
        sourceResumeId,
        jobTargetId: input.targetId,
      });
      await refreshAll();
      return { sourceResumeId, variantId: variant.id };
    }).catch(() => undefined);
  };

  useTaskResult<{ sourceResumeId: string; variantId: string }>(optimizeKey, (done) => {
    setResumeForm({ label: '', rawText: '' });
    setResumeFormOpen(false);
    setOptimizeBaseResumeId('');
    setSelectedResumeId(done.sourceResumeId);
    setListSelection({ kind: 'variant', id: done.variantId });
    setActiveVariantId(done.variantId);
    setMessage('优化版已生成');
  });

  /** 编辑器自动保存的落库入口：成功时不打扰用户，失败才提示并抛回给编辑器 */
  const saveEditorDocument = async (payload: ResumeEditorSavePayload): Promise<void> => {
    if (!editorKind || !editorId) return;
    try {
      if (editorKind === 'variant') {
        await invoke('resumeVariant:update', {
          id: editorId,
          contentMd: payload.contentMd,
          previewStyle: payload.previewStyle,
        });
      } else {
        await invoke('resume:update', {
          id: editorId,
          label: payload.label,
          rawText: payload.contentMd,
          previewStyle: payload.previewStyle,
        });
      }
      await refreshAll();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const deleteTarget = (id: string): void => {
    if (!confirm('确定删除此目标岗位？')) return;
    setMessage(null);
    void runTask(`jobTarget:delete:${id}`, async () => {
      await invoke('jobTarget:delete', { id });
      await refreshAll();
      return '目标岗位已删除';
    })
      .then((msg) => {
        if (targetForm.id === id) closeTargetForm();
        if (selectedTargetId === id) setSelectedTargetId(null);
        setMessage(msg);
      })
      .catch(() => undefined);
  };

  const deleteResume = (id: string): void => {
    if (!confirm('确定删除此简历？由它生成的优化版会保留为独立简历。')) return;
    setMessage(null);
    void runTask(`resume:delete:${id}`, async () => {
      await invoke('resume:delete', { id });
      await refreshAll();
      return '简历已删除';
    })
      .then((msg) => {
        if (selectedResumeId === id) {
          setSelectedResumeId(null);
          setListSelection(null);
        }
        setMessage(msg);
      })
      .catch(() => undefined);
  };

  const deleteVariant = (id: string): void => {
    if (!confirm('确定删除此优化版？')) return;
    setMessage(null);
    void runTask(`resumeVariant:delete:${id}`, async () => {
      await invoke('resumeVariant:delete', { id });
      await refreshAll();
      return '优化版已删除';
    })
      .then((msg) => {
        if (activeVariantId === id) setActiveVariantId(null);
        if (listSelection?.kind === 'variant' && listSelection.id === id) {
          setListSelection(selectedResumeId ? { kind: 'resume', id: selectedResumeId } : null);
        }
        setMessage(msg);
      })
      .catch(() => undefined);
  };

  return (
    <PageShell className="flex h-full min-h-0 flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">简历</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          管理目标岗位与母版简历；优化版仅改写表述与结构，事实必须来自母版，不编造经历
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

      {(taskFailure ?? message) && (
        <p className={`text-xs ${taskFailure ? 'text-red-400' : 'text-[var(--color-muted)]'}`}>
          {taskFailure ?? message}
        </p>
      )}

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
                  <div
                    key={t.id}
                    className={`group relative rounded-lg border transition-colors ${
                      selectedTargetId === t.id
                        ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                        : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]/50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectTarget(t.id)}
                      className="w-full p-3 pr-10 text-left text-sm"
                    >
                      <div className="truncate font-medium">{t.company}</div>
                      <div className="truncate text-xs text-[var(--color-muted)]">{t.roleTitle}</div>
                    </button>
                    <TaskButton
                      taskKey={`jobTarget:delete:${t.id}`}
                      onClick={() => deleteTarget(t.id)}
                      runningLabel="删除中…"
                      title="删除"
                      className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] transition-opacity hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                      // 平时靠悬停显形，删除中要一直看得见进度
                      idleClassName="opacity-0"
                    >
                      删除
                    </TaskButton>
                  </div>
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
                      disabled={savingTarget}
                      onClick={saveTarget}
                      className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      {savingTarget ? '保存中…' : '保存'}
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
                  <button
                    type="button"
                    onClick={() => editTarget(selectedTarget)}
                    className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
                  >
                    编辑
                  </button>
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
                  <div
                    key={`${entry.kind}-${entry.id}`}
                    className={`group relative rounded-lg border transition-colors ${
                      isEntrySelected(entry)
                        ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                        : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]/50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectSidebarEntry(entry)}
                      className="w-full p-3 pr-10 text-left text-sm"
                    >
                      <div className="truncate font-medium">{entry.label}</div>
                      <div className="truncate text-xs text-[var(--color-muted)]">
                        {entry.subtitle}
                      </div>
                    </button>
                    {entry.id !== NEW_RESUME_DRAFT_ID && (
                      <TaskButton
                        taskKey={
                          entry.kind === 'variant'
                            ? `resumeVariant:delete:${entry.id}`
                            : `resume:delete:${entry.id}`
                        }
                        onClick={() =>
                          entry.kind === 'variant' ? deleteVariant(entry.id) : deleteResume(entry.id)
                        }
                        runningLabel="删除中…"
                        title="删除"
                        className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-[var(--color-muted)] transition-opacity hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                        // 平时靠悬停显形，删除中要一直看得见进度
                        idleClassName="opacity-0"
                      >
                        删除
                      </TaskButton>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)]">
            {resumeFormOpen ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold">新建简历</h3>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      粘贴或导入原始简历，保存后即可用结构化表单编辑
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      disabled={creatingResume}
                      onClick={saveResume}
                      className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      {creatingResume ? '保存中…' : '保存'}
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
                      disabled={importingResume}
                      onClick={importResume}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      {importingResume ? '导入中…' : '导入文件'}
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
                    readOnly={Boolean(optimizeBaseResumeId)}
                    placeholder="简历正文（新建 base 简历时填写；或从下方选择已有简历作为优化来源）"
                    className="min-h-0 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed disabled:opacity-80"
                  />
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs text-[var(--color-muted)]">优化 base 的简历</span>
                    <select
                      value={optimizeBaseResumeId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setOptimizeBaseResumeId(id);
                        const picked = resumes.find((r) => r.id === id);
                        if (picked) {
                          setResumeForm((f) => ({
                            ...f,
                            label: f.label || picked.label,
                            rawText: picked.rawText,
                          }));
                        }
                      }}
                      className="min-w-[160px] rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
                    >
                      <option value="">下方正文（新建）</option>
                      {resumes.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                    <span className="text-xs text-[var(--color-muted)]">目标岗位</span>
                    <select
                      value={optimizeTargetId}
                      onChange={(e) => setOptimizeTargetId(e.target.value)}
                      className="min-w-[200px] rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
                    >
                      {targets.length === 0 && <option value="">暂无目标岗位</option>}
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>{t.company} · {t.roleTitle}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={optimizing || !optimizeTargetId || targets.length === 0}
                      onClick={runOptimizeFromNewResume}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      {optimizing ? '生成中…' : '生成优化版'}
                    </button>
                  </div>
                </div>
              </div>
            ) : editorKind === 'variant' && activeVariant ? (
              <ResumeEditorPane
                key={`variant-${activeVariant.id}`}
                kind="variant"
                taskScope={`variant:${activeVariant.id}`}
                initialContentMd={activeVariant.contentMd}
                initialPreviewStyle={activeVariant.previewStyle}
                initialLabel={activeVariant.label}
                heading={`${activeVariant.company} · ${activeVariant.roleTitle}`}
                subtitle={
                  activeVariant.sourceResumeLabel
                    ? `来自 ${activeVariant.sourceResumeLabel}`
                    : '母版已删除，这份优化版独立保留'
                }
                variantMeta={{
                  headline: activeVariant.label,
                  subtitle: `${activeVariant.company} · ${activeVariant.roleTitle}`,
                }}
                onSave={saveEditorDocument}
                onMessage={setMessage}
              />
            ) : editorKind === 'resume' && selectedResume ? (
              <ResumeEditorPane
                key={`resume-${selectedResume.id}`}
                kind="resume"
                taskScope={`resume:${selectedResume.id}`}
                initialContentMd={selectedResume.rawText}
                initialPreviewStyle={selectedResume.previewStyle}
                initialLabel={selectedResume.label}
                subtitle={`母版 · 更新于 ${new Date(selectedResume.updatedAt).toLocaleString()}`}
                onSave={saveEditorDocument}
                onMessage={setMessage}
              />
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
