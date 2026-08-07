import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignDetail as CampaignDetailData } from '@shared/ipc';
import type { Resume } from '@shared/entities';
import { CompanyIntelCard } from '../components/CompanyIntelCard';
import { KnowledgeTree } from '../components/KnowledgeTree';
import { invoke } from '../ipc';
import { useJobProgress } from '../ipc/useJobProgress';

export function CampaignDetail({
  id,
  autoDiagnose,
  onBack,
}: {
  id: string;
  autoDiagnose?: boolean;
  onBack: () => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<CampaignDetailData | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [reportText, setReportText] = useState('');
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [newResumeLabel, setNewResumeLabel] = useState('我的简历');
  const [newResumeText, setNewResumeText] = useState('');
  const [showResumeForm, setShowResumeForm] = useState(false);
  const { active: job, lastMessage } = useJobProgress();

  const refresh = useCallback(() => {
    void invoke('campaign:get', { id }).then(setDetail);
    void invoke('resume:list', undefined).then(setResumes);
  }, [id]);

  const autoRan = useRef(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoDiagnose || autoRan.current) return;
    autoRan.current = true;
    void invoke('diagnosis:fromJd', { campaignId: id });
  }, [id, autoDiagnose]);

  useEffect(() => {
    if (!job && lastMessage) refresh();
  }, [job, lastMessage, refresh]);

  const runDiagnosis = async (): Promise<void> => {
    await invoke('diagnosis:fromJd', { campaignId: id });
  };

  const attachResume = async (resumeId: string): Promise<void> => {
    await invoke('diagnosis:attachResume', { campaignId: id, resumeId });
  };

  const createAndAttachResume = async (): Promise<void> => {
    if (!newResumeText.trim()) return;
    const r = await invoke('resume:create', {
      label: newResumeLabel.trim() || '我的简历',
      rawText: newResumeText.trim(),
    });
    setShowResumeForm(false);
    setNewResumeText('');
    await attachResume(r.id);
  };

  const expandNode = async (nodeId: string): Promise<void> => {
    setExpandingId(nodeId);
    try {
      await invoke('diagnosis:expandNode', { nodeId });
    } finally {
      setExpandingId(null);
    }
  };

  const fetchIntel = async (): Promise<void> => {
    await invoke('diagnosis:fetchIntel', { campaignId: id });
  };

  const ingestReport = async (): Promise<void> => {
    if (!reportText.trim()) return;
    await invoke('diagnosis:ingestReport', { campaignId: id, rawText: reportText.trim() });
    setReportText('');
    refresh();
  };

  const deleteNode = async (nodeId: string): Promise<void> => {
    await invoke('node:delete', { id: nodeId });
    refresh();
  };

  if (!detail) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载中…</p>;
  }

  const { campaign, nodes, intel } = detail;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          ← 返回列表
        </button>
        <h2 className="text-lg font-semibold">
          {campaign.company} · {campaign.roleTitle}
        </h2>
        {job && (
          <p className="text-xs text-sky-400">
            {job.label}：{job.message}
            {job.progress !== null ? ` (${Math.round(job.progress * 100)}%)` : ''}
          </p>
        )}
        {!job && lastMessage && (
          <p className="text-xs text-emerald-400">{lastMessage}</p>
        )}
      </header>

      <section className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={Boolean(job)}
          onClick={() => void runDiagnosis()}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {nodes.length ? '重新诊断 JD' : '开始诊断'}
        </button>
        <button
          type="button"
          disabled={Boolean(job)}
          onClick={() => void fetchIntel()}
          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          生成公司情报
        </button>
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <h3 className="text-sm font-medium text-[var(--color-muted)]">
            考点清单（{nodes.length}）
          </h3>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <KnowledgeTree
              nodes={nodes}
              onExpand={(nid) => void expandNode(nid)}
              onDelete={(nid) => void deleteNode(nid)}
              expandingId={expandingId}
            />
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">简历</h3>
            {detail.resume ? (
              <p className="text-xs text-emerald-400">已关联：{detail.resume.label}</p>
            ) : (
              <>
                {resumes.length > 0 && (
                  <select
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) void attachResume(e.target.value);
                    }}
                  >
                    <option value="">选择已有简历…</option>
                    {resumes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => setShowResumeForm((v) => !v)}
                  className="text-xs text-sky-400 hover:underline"
                >
                  {showResumeForm ? '取消' : '+ 粘贴新简历'}
                </button>
                {showResumeForm && (
                  <div className="space-y-2">
                    <input
                      value={newResumeLabel}
                      onChange={(e) => setNewResumeLabel(e.target.value)}
                      className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                    />
                    <textarea
                      value={newResumeText}
                      onChange={(e) => setNewResumeText(e.target.value)}
                      rows={6}
                      placeholder="粘贴简历全文…"
                      className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      disabled={Boolean(job)}
                      onClick={() => void createAndAttachResume()}
                      className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs disabled:opacity-40"
                    >
                      保存并交叉分析
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">公司情报</h3>
            {intel ? (
              <CompanyIntelCard intel={intel} />
            ) : (
              <p className="text-xs text-[var(--color-muted)]">点击「生成公司情报」联网检索</p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">面经粘贴</h3>
            <p className="text-xs text-[var(--color-muted)]">
              粘贴面经原文，提取真题并修正考点考察概率
            </p>
            <textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              rows={4}
              className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              placeholder="粘贴面经…"
            />
            <button
              type="button"
              disabled={!reportText.trim() || Boolean(job)}
              onClick={() => void ingestReport()}
              className="rounded border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
            >
              摄入面经
            </button>
            {detail.reportCount > 0 && (
              <p className="text-xs text-[var(--color-muted)]">已摄入 {detail.reportCount} 篇</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
