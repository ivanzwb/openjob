import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnnotationView,
  CampaignDetail as CampaignDetailData,
  InterviewReportView,
  NodeEdgeView,
  Nudge,
} from '@shared/ipc';
import type { Resume } from '@shared/entities';
import type { EdgeRelation, NodeKind } from '@shared/enums';
import { AnnotationDigest } from '../components/AnnotationDigest';
import { AnnotationTools } from '../components/AnnotationTools';
import { CompanyIntelCard } from '../components/CompanyIntelCard';
import { EdgeEditor } from '../components/EdgeEditor';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import { KnowledgeTree, type NodePatch } from '../components/KnowledgeTree';
import { NudgePanel } from '../components/NudgePanel';
import { PlanDecisionLog } from '../components/PlanDecisionLog';
import { ReportSourceList } from '../components/ReportSourceList';
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
  const [debriefText, setDebriefText] = useState('');
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [newResumeLabel, setNewResumeLabel] = useState('我的简历');
  const [newResumeText, setNewResumeText] = useState('');
  const [showResumeForm, setShowResumeForm] = useState(false);
  const [importingResume, setImportingResume] = useState(false);
  const [interviewDate, setInterviewDate] = useState('');
  const [dailyMinutes, setDailyMinutes] = useState('90');
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [planLogKey, setPlanLogKey] = useState(0);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [noteCounts, setNoteCounts] = useState<Map<string, number>>(new Map());
  const [edges, setEdges] = useState<NodeEdgeView[]>([]);
  const [showEdges, setShowEdges] = useState(false);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [applyingHistory, setApplyingHistory] = useState(false);
  const [webIngesting, setWebIngesting] = useState(false);
  const [reports, setReports] = useState<InterviewReportView[]>([]);
  const [showReports, setShowReports] = useState(false);
  const [annotations, setAnnotations] = useState<AnnotationView[]>([]);
  const { active: job, lastMessage, lastError } = useJobProgress();
  const [expandError, setExpandError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void invoke('campaign:get', { id }).then((d) => {
      setDetail(d);
      setInterviewDate(d.campaign.interviewDate ?? '');
      setDailyMinutes(String(d.campaign.dailyMinutes ?? 90));
    });
    void invoke('resume:list', undefined).then(setResumes);
    void invoke('annotation:listForCampaign', { campaignId: id }).then((anns) => {
      setAnnotations(anns);
      // 树上的角标只反映挂在知识点本身的标记，讲解/真题/情报卡的标记走「我的标记」
      const onNodes = anns.filter((a) => a.targetType === 'node');
      setBookmarkedIds(
        new Set(onNodes.filter((a) => a.kind === 'bookmark').map((a) => a.targetId)),
      );
      const counts = new Map<string, number>();
      for (const a of onNodes) {
        if (a.kind !== 'note' && a.kind !== 'highlight') continue;
        counts.set(a.targetId, (counts.get(a.targetId) ?? 0) + 1);
      }
      setNoteCounts(counts);
    });
    void invoke('edge:list', { campaignId: id }).then(setEdges);
    void invoke('insight:nudges', { campaignId: id }).then(setNudges);
    void invoke('diagnosis:listReports', { campaignId: id }).then(setReports);
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

  /** 从文件导入简历到简历库；attach=true 时随即关联到当前战役并触发交叉分析 */
  const importResumeFile = async (attach: boolean): Promise<void> => {
    setImportingResume(true);
    try {
      const r = await invoke('resume:importFile', undefined);
      if (!r) return; // 用户取消
      refresh();
      if (attach) await attachResume(r.id);
    } finally {
      setImportingResume(false);
    }
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
    setExpandError(null);
    try {
      await invoke('diagnosis:expandNode', { nodeId });
    } catch (err) {
      setExpandError(err instanceof Error ? err.message : String(err));
    } finally {
      setExpandingId(null);
    }
  };

  const fetchIntel = async (): Promise<void> => {
    await invoke('diagnosis:fetchIntel', { campaignId: id });
  };

  const ingestReport = async (sourceType: 'pasted' | 'selfDebrief'): Promise<void> => {
    const raw = sourceType === 'selfDebrief' ? debriefText : reportText;
    if (!raw.trim()) return;
    setIngestMsg(null);
    try {
      const res = await invoke('diagnosis:ingestReport', {
        campaignId: id,
        rawText: raw.trim(),
        sourceType,
      });
      setIngestMsg(
        `提取 ${res.questionsExtracted} 题，更新 ${res.nodesUpdated} 个考点` +
          (res.blindSpotsCreated ? `，新增 ${res.blindSpotsCreated} 个盲区考点` : '') +
          (res.crossCampaignUpdated ? `，跨 Campaign 修正 ${res.crossCampaignUpdated} 处` : '') +
          (res.unverifiedCount
            ? `；${res.corroboratedCount} 处多源印证、${res.unverifiedCount} 处单一来源（权重减半）`
            : ''),
      );
      if (sourceType === 'selfDebrief') setDebriefText('');
      else setReportText('');
      refresh();
    } catch (err) {
      setIngestMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteNode = async (nodeId: string): Promise<void> => {
    await invoke('node:delete', { id: nodeId });
    refresh();
  };

  const updateNode = async (nodeId: string, patch: NodePatch): Promise<void> => {
    await invoke('node:update', { id: nodeId, ...patch });
    refresh();
  };

  const addNote = async (nodeId: string, noteMd: string): Promise<void> => {
    await invoke('annotation:create', {
      targetType: 'node',
      targetId: nodeId,
      kind: 'note',
      noteMd,
    });
    refresh();
  };

  const createEdge = async (
    fromNodeId: string,
    toNodeId: string,
    relation: EdgeRelation,
  ): Promise<void> => {
    try {
      const edge = await invoke('edge:create', { fromNodeId, toNodeId, relation });
      setEdges((prev) => [...prev, edge]);
    } catch (err) {
      setIngestMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const removeEdge = async (edgeId: string): Promise<void> => {
    await invoke('edge:delete', { id: edgeId });
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
  };

  const applyHistory = async (): Promise<void> => {
    setApplyingHistory(true);
    try {
      const res = await invoke('insight:applyHistory', { campaignId: id });
      setNudges(res.nudges);
      setPlanMsg(
        res.boosted + res.eased === 0
          ? '历史信号暂无可回写的内容'
          : `已生成 ${res.boosted} 处提权、${res.eased} 处拆小，优先级已刷新`,
      );
      refresh();
    } finally {
      setApplyingHistory(false);
    }
  };

  const createChildNode = async (
    parentId: string,
    name: string,
    kind: NodeKind,
  ): Promise<void> => {
    await invoke('node:create', { campaignId: id, parentId, name, kind });
    refresh();
  };

  const ingestWeb = async (): Promise<void> => {
    setIngestMsg(null);
    setWebIngesting(true);
    try {
      const res = await invoke('diagnosis:ingestWeb', { campaignId: id });
      setIngestMsg(
        `联网摄入 ${res.reports.length} 篇（抓取 ${res.sourcesFetched} 页），` +
          `提取 ${res.totalQuestions} 题，更新 ${res.totalNodesUpdated} 个考点`,
      );
      refresh();
    } catch (err) {
      setIngestMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWebIngesting(false);
    }
  };

  const toggleBookmark = async (nodeId: string): Promise<void> => {
    const res = await invoke('annotation:toggleBookmark', {
      targetType: 'node',
      targetId: nodeId,
    });
    setBookmarkedIds((prev) => {
      const next = new Set(prev);
      if (res.bookmarked) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  };

  const generatePlan = async (): Promise<void> => {
    setPlanMsg(null);
    try {
      const res = await invoke('plan:generate', {
        campaignId: id,
        interviewDate: interviewDate || undefined,
        dailyMinutes: Number(dailyMinutes) || 90,
      });
      setPlanMsg(
        `已生成 ${res.daysCreated} 天计划、${res.tasksCreated} 个任务` +
          (res.overflowFallbacks ? `（含 ${res.overflowFallbacks} 个兜底话术）` : ''),
      );
      setPlanLogKey((k) => k + 1);
      refresh();
    } catch (err) {
      setPlanMsg(err instanceof Error ? err.message : String(err));
    }
  };

  if (!detail) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载中…</p>;
  }

  const { campaign, nodes, intel } = detail;

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 p-6">
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
          {campaign.status === 'done' && (
            <span className="ml-2 text-xs font-normal text-emerald-400">已复盘</span>
          )}
        </h2>
        {detail.historicalPriorCampaigns > 0 && (
          <p className="text-xs text-sky-400">
            已累积 {detail.historicalPriorCampaigns} 个 Campaign 的真题先验
          </p>
        )}
        {job && (
          <p className="text-xs text-sky-400">
            {job.label}：{job.message}
            {job.progress !== null ? ` (${Math.round(job.progress * 100)}%)` : ''}
          </p>
        )}
        {!job && lastError && (
          <p className="text-xs font-medium text-red-400">{lastError}</p>
        )}
        {!job && !lastError && expandError && (
          <p className="text-xs font-medium text-red-400">{expandError}</p>
        )}
        {!job && !lastError && !expandError && lastMessage && (
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

      <section className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="text-sm font-medium">日程编排</h3>
        <p className="text-xs text-[var(--color-muted)]">
          设置面试日期和每日时长后生成计划，然后到「今日」页执行任务
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-[var(--color-muted)]">面试日期</span>
            <input
              type="date"
              value={interviewDate}
              onChange={(e) => setInterviewDate(e.target.value)}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-[var(--color-muted)]">每日分钟</span>
            <input
              type="number"
              min={30}
              max={480}
              value={dailyMinutes}
              onChange={(e) => setDailyMinutes(e.target.value)}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={nodes.length === 0}
          onClick={() => void generatePlan()}
          className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          生成计划
        </button>
        {planMsg && (
          <p className={`text-xs ${planMsg.includes('已生成') ? 'text-emerald-400' : 'text-red-400'}`}>
            {planMsg}
          </p>
        )}
        <PlanDecisionLog campaignId={id} reloadKey={planLogKey} />
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-muted)]">
              考点清单（{nodes.length}）· {edges.length} 条关系
            </h3>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowEdges((v) => !v)}
                className="text-xs text-sky-400 hover:underline"
              >
                {showEdges ? '收起关系' : '编辑关系'}
              </button>
              <button
                type="button"
                onClick={() => setShowGraph((v) => !v)}
                className="text-xs text-sky-400 hover:underline"
              >
                {showGraph ? '切换清单' : '图谱视图'}
              </button>
            </div>
          </div>
          {showEdges && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <EdgeEditor
                nodes={nodes}
                edges={edges}
                onCreate={(f, t, r) => void createEdge(f, t, r)}
                onDelete={(eid) => void removeEdge(eid)}
              />
            </div>
          )}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            {showGraph ? (
              <KnowledgeGraph nodes={nodes} edges={edges} />
            ) : (
              <KnowledgeTree
                nodes={nodes}
                bookmarkedIds={bookmarkedIds}
                noteCountByNode={noteCounts}
                onExpand={(nid) => void expandNode(nid)}
                onDelete={(nid) => void deleteNode(nid)}
                onUpdate={(nid, patch) => void updateNode(nid, patch)}
                onCreateChild={(pid, name, kind) => void createChildNode(pid, name, kind)}
                onToggleBookmark={(nid) => void toggleBookmark(nid)}
                onAddNote={(nid, note) => void addNote(nid, note)}
                expandingId={expandingId}
              />
            )}
          </div>
          {detail.blindSpotQuestions.length > 0 && (
            <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4">
              <h3 className="text-sm font-medium text-amber-300">
                盲区真题（{detail.blindSpotQuestions.length}）
              </h3>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                图谱未能预测到的题目，信息价值最高，建议优先补学
              </p>
              <ul className="mt-2 space-y-2 text-sm">
                {detail.blindSpotQuestions.map((q) => (
                  <li key={q.id} className="space-y-1 text-amber-100/90">
                    <div>· {q.questionText}</div>
                    <div className="pl-3">
                      <AnnotationTools
                        targetType="question"
                        targetId={q.id}
                        notePlaceholder="记下你的答题思路"
                        onChange={refresh}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">我的标记</h3>
            <AnnotationDigest annotations={annotations} onChange={refresh} />
          </div>

          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">该提醒你的事</h3>
            <NudgePanel
              nudges={nudges}
              applying={applyingHistory}
              onApplyHistory={() => void applyHistory()}
            />
          </div>

          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">简历</h3>
            {detail.resume ? (
              <div className="space-y-2">
                <p className="text-xs text-emerald-400">已关联：{detail.resume.label}</p>
                <button
                  type="button"
                  disabled={importingResume}
                  onClick={() => void importResumeFile(true)}
                  className="text-xs text-sky-400 hover:underline disabled:opacity-40"
                >
                  {importingResume ? '导入中…' : '从文件导入以替换并重新交叉分析'}
                </button>
              </div>
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
                <div className="flex gap-4">
                  <button
                    type="button"
                    disabled={importingResume}
                    onClick={() => void importResumeFile(true)}
                    className="text-xs text-sky-400 hover:underline disabled:opacity-40"
                  >
                    {importingResume ? '导入中…' : '从文件导入并交叉分析'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowResumeForm((v) => !v)}
                    className="text-xs text-sky-400 hover:underline"
                  >
                    {showResumeForm ? '取消' : '+ 粘贴新简历'}
                  </button>
                </div>
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
              <CompanyIntelCard intel={intel} onAnnotationChange={refresh} />
            ) : (
              <p className="text-xs text-[var(--color-muted)]">点击「生成公司情报」联网检索</p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="text-sm font-medium">面经摄入</h3>
            <p className="text-xs text-[var(--color-muted)]">
              粘贴面经原文，或联网搜索自动摄入
            </p>
            <button
              type="button"
              disabled={webIngesting || Boolean(job)}
              onClick={() => void ingestWeb()}
              className="rounded border border-sky-800 bg-sky-950/40 px-3 py-1 text-xs text-sky-300 disabled:opacity-40"
            >
              {webIngesting ? '搜索摄入中…' : '搜索摄入面经'}
            </button>
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
              onClick={() => void ingestReport('pasted')}
              className="rounded border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
            >
              摄入面经
            </button>
            {detail.reportCount > 0 && (
              <button
                type="button"
                onClick={() => setShowReports((v) => !v)}
                className="text-left text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                已摄入 {detail.reportCount} 篇 · {showReports ? '收起出处' : '查看出处'}
              </button>
            )}
            {showReports && <ReportSourceList reports={reports} />}
            {ingestMsg && (
              <p
                className={`text-xs ${ingestMsg.includes('提取') ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {ingestMsg}
              </p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4">
            <h3 className="text-sm font-medium text-emerald-300">面后复盘</h3>
            <p className="text-xs text-[var(--color-muted)]">
              面完当天录入实际被问到的题，可信度最高，会自动标记 Campaign 为已复盘
            </p>
            <textarea
              value={debriefText}
              onChange={(e) => setDebriefText(e.target.value)}
              rows={5}
              className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              placeholder="今天面试被问了什么？按轮次或顺序写下…"
            />
            <button
              type="button"
              disabled={!debriefText.trim() || Boolean(job)}
              onClick={() => void ingestReport('selfDebrief')}
              className="rounded bg-emerald-700 px-3 py-1 text-xs disabled:opacity-40"
            >
              提交复盘
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
