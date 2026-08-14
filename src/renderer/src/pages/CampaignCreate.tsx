import { useEffect, useState } from 'react';
import type { JobTarget } from '@shared/entities';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';
import { PageShell } from '../components/PageShell';

export function CampaignCreate({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [targets, setTargets] = useState<JobTarget[]>([]);
  const [jobTargetId, setJobTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 按岗位记：创建过程中切走再回来，按钮还是「创建中…」，也不会重复建一份
  const createKey = `campaign:create:${jobTargetId}`;
  const { running: busy, error: createError } = useTask(createKey);

  useEffect(() => {
    void invoke('jobTarget:list', undefined).then((list) => {
      setTargets(list);
      if (list[0]) setJobTargetId(list[0].id);
    });
  }, []);

  const submit = (): void => {
    if (!jobTargetId) {
      setError('请选择目标岗位，或在「简历 → 目标岗位」中新建');
      return;
    }
    setError(null);
    void runTask(createKey, () => invoke('campaign:create', { jobTargetId })).catch(() => undefined);
  };

  useTaskResult<{ id: string }>(createKey, (created) => onCreated(created.id));

  const selected = targets.find((t) => t.id === jobTargetId);

  return (
    <PageShell className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">新建备考</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          选择目标岗位（公司 / 岗位 / JD 在「简历」页维护），创建后可补简历与面试日期
        </p>
      </header>

      <label className="block space-y-1">
        <span className="text-sm text-[var(--color-muted)]">目标岗位 *</span>
        <select
          value={jobTargetId}
          onChange={(e) => setJobTargetId(e.target.value)}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        >
          {targets.length === 0 && <option value="">暂无岗位，请先去简历页创建</option>}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.company} · {t.roleTitle}</option>
          ))}
        </select>
      </label>

      {selected && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted)]">
          <div className="font-medium text-[var(--color-fg)]">{selected.company} · {selected.roleTitle}</div>
          <p className="mt-2 line-clamp-8 whitespace-pre-wrap">{selected.jdRaw}</p>
        </div>
      )}

      {(error ?? createError) && <p className="text-sm text-red-400">{error ?? createError}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !jobTargetId}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '创建中…' : '创建并进入诊断'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm"
        >
          取消
        </button>
      </div>
    </PageShell>
  );
}
