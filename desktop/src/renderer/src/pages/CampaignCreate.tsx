import { useEffect, useState } from 'react';
import type { JobTarget, Resume } from '@core/entities';
import type { ResumeVariantView } from '@core/ipc';
import { latestVariantOfTarget, pickDefaultResumeId } from '@core/resume/campaignBinding';
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
  const [resumes, setResumes] = useState<Resume[]>([]);
  // 这两份状态都把所属岗位一起记下来，读的时候比对当前岗位再决定用不用。
  // 换成「岗位一变就在 effect 里同步重置」会多跑一轮渲染，也挡不住请求乱序返回时
  // 把上一个岗位的优化版列表写进来。
  const [variants, setVariants] = useState<{ jobTargetId: string; items: ResumeVariantView[] }>({
    jobTargetId: '',
    items: [],
  });
  // null = 用户没动过选择，提交时由前端按默认规则算
  const [resumePick, setResumePick] = useState<{ jobTargetId: string; resumeId: string | null }>({
    jobTargetId: '',
    resumeId: null,
  });
  const variantsOfTarget = variants.jobTargetId === jobTargetId ? variants.items : [];
  const resumeId = resumePick.jobTargetId === jobTargetId ? resumePick.resumeId : null;
  const [error, setError] = useState<string | null>(null);
  // 按岗位记：创建过程中切走再回来，按钮还是「创建中…」，也不会重复建一份
  const createKey = `campaign:create:${jobTargetId}`;
  const { running: busy, error: createError } = useTask(createKey);

  useEffect(() => {
    void invoke('jobTarget:list', undefined).then((list) => {
      setTargets(list);
      if (list[0]) setJobTargetId(list[0].id);
    });
    void invoke('resume:list', undefined).then(setResumes);
  }, []);

  // 目标岗位切换后按默认规则预选简历；选项仍允许手动改
  useEffect(() => {
    if (!jobTargetId) return;
    let active = true;
    void invoke('resumeVariant:list', { jobTargetId }).then((items) => {
      if (active) setVariants({ jobTargetId, items });
    });
    return () => {
      active = false;
    };
  }, [jobTargetId]);

  const resumeOptions = [...resumes].sort((a, b) => b.updatedAt - a.updatedAt);
  const hintVariant = latestVariantOfTarget(variantsOfTarget);
  const hintVariantView = variantsOfTarget.find((v) => v.id === hintVariant?.id) ?? null;
  const hasResume = resumeOptions.length > 0;

  const submit = (): void => {
    if (!jobTargetId) {
      setError('请选择目标岗位，或在「简历 → 目标岗位」中新建');
      return;
    }
    setError(null);
    void runTask(createKey, () =>
      invoke('campaign:create', {
        jobTargetId,
        resumeId: resumeId ?? (hasResume ? pickDefaultResumeId(variantsOfTarget, resumeOptions) : null),
      }),
    ).catch(() => undefined);
  };

  useTaskResult<{ id: string }>(createKey, (created) => onCreated(created.id));

  const selected = targets.find((t) => t.id === jobTargetId);

  return (
    <PageShell className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">新建备考</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          选择目标岗位（公司 / 岗位 / JD 在「简历」页维护）；简历默认按岗位自动匹配，可手动改
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

      <label className="block space-y-1">
        <span className="text-sm text-[var(--color-muted)]">简历</span>
        {!hasResume ? (
          <div className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted)]">
            暂无简历：出题与参考答案将无法结合你的履历，请先到「简历」页导入母版
          </div>
        ) : (
          <>
            <select
              value={resumeId ?? pickDefaultResumeId(variantsOfTarget, resumeOptions) ?? ''}
              onChange={(e) => setResumePick({ jobTargetId, resumeId: e.target.value || null })}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              {resumeOptions.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
            {hintVariantView && (
              <p className="pt-1 text-xs text-[var(--color-muted)]">
                该岗位已有优化版「{hintVariantView.label}」，默认使用它（其母版：{' '}
                {resumeOptions.find((r) => r.id === hintVariantView.sourceResumeId)?.label ??
                  '母版已删除'}
                ），答题上下文将以优化版表述为准
              </p>
            )}
          </>
        )}
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
