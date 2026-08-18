import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnnotationView,
  CampaignDetail as CampaignDetailData,
  InterviewReportView,
  NodeEdgeView,
  Nudge,
  TaskView,
  TodayPlan,
} from '@shared/ipc';
import type { Resume } from '@shared/entities';
import type { EdgeRelation, NodeKind, NodeStatus } from '@shared/enums';
import { AnnotationDigest } from '../components/AnnotationDigest';
import { AnnotationTools } from '../components/AnnotationTools';
import { CompanyIntelCard } from '../components/CompanyIntelCard';
import { EdgeEditor } from '../components/EdgeEditor';
import { StudyPlanCalendarPopover } from '../components/StudyPlanCalendarPopover';
import { nodeIdsForPlanFilter, nodeIdsForTreeFilter } from '@shared/planFilter';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import { KnowledgeTree, type NodePatch } from '../components/KnowledgeTree';
import { NodeFollowUpChat } from '../components/NodeFollowUpChat';
import { NudgePanel } from '../components/NudgePanel';
import { QuizPanel } from '../components/QuizPanel';
import { ReportSourceList } from '../components/ReportSourceList';
import { TaskStudyPanel } from '../components/TaskStudyPanel';
import { PageShell } from '../components/PageShell';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { useJobFeedback, useJobProgress } from '../ipc/useJobProgress';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

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
  const [pendingExpandNodeId, setPendingExpandNodeId] = useState<string | null>(null);
  const [newResumeLabel, setNewResumeLabel] = useState('我的简历');
  const [newResumeText, setNewResumeText] = useState('');
  const [showResumeForm, setShowResumeForm] = useState(false);
  const [interviewDate, setInterviewDate] = useState('');
  const [dailyMinutes, setDailyMinutes] = useState('90');
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [planLogKey, setPlanLogKey] = useState(0);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [noteCounts, setNoteCounts] = useState<Map<string, number>>(new Map());
  const [edges, setEdges] = useState<NodeEdgeView[]>([]);
  const [showEdges, setShowEdges] = useState(false);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [reports, setReports] = useState<InterviewReportView[]>([]);
  const [showReports, setShowReports] = useState(false);
  const [annotations, setAnnotations] = useState<AnnotationView[]>([]);
  const [pageTab, setPageTab] = useState<'intel' | 'study' | 'materials'>('intel');
  const [calendarFilterDate, setCalendarFilterDate] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<NodeStatus | 'all'>('all');
  const [markFilter, setMarkFilter] = useState<'all' | 'bookmarked' | 'marked' | 'last'>('all');
  const [filterPlan, setFilterPlan] = useState<TodayPlan | null>(null);
  const [prevCalendarFilterDate, setPrevCalendarFilterDate] = useState<string | null>(calendarFilterDate);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(() =>
    window.localStorage.getItem(`openjob:lastNode:${id}`),
  );
  const [nodeStudyMode, setNodeStudyMode] = useState<'explain' | 'drill' | 'followUp'>('explain');
  const { active: job, lastResult } = useJobProgress();
  const jdJob = useJobFeedback('JD 诊断');
  const intelJob = useJobFeedback('公司情报');
  const resumeJob = useJobFeedback('简历交叉分析');
  const expandJob = useJobFeedback('细化考点');

  // 这些动作跑在渲染进程里，状态挂在按战役取的 key 上：
  // 切到别的页签、关掉弹窗再回来，按钮仍显示进行中，结果也会补上
  const ingestWebKey = `campaign:${id}:ingestWeb`;
  const ingestPastedKey = `campaign:${id}:ingestReport:pasted`;
  const ingestDebriefKey = `campaign:${id}:ingestReport:selfDebrief`;
  const importResumeKey = `campaign:${id}:importResume`;
  const createResumeKey = `campaign:${id}:createResume`;
  const applyHistoryKey = `campaign:${id}:applyHistory`;
  const planGenerateKey = `campaign:${id}:planGenerate`;
  const ingestWebTask = useTask(ingestWebKey);
  const ingestPastedTask = useTask(ingestPastedKey);
  const ingestDebriefTask = useTask(ingestDebriefKey);
  const importResumeTask = useTask(importResumeKey);
  const createResumeTask = useTask(createResumeKey);
  const applyHistoryTask = useTask(applyHistoryKey);
  const planTask = useTask(planGenerateKey);
  const webIngesting = ingestWebTask.running;
  const importingResume = importResumeTask.running;
  const applyingHistory = applyHistoryTask.running;

  // 摄入/导入类动作的结果与错误都走同一条提示，跑完再回来也看得到
  useTaskResult<string>(ingestWebKey, setIngestMsg);
  useTaskResult<string>(ingestPastedKey, setIngestMsg);
  useTaskResult<string>(ingestDebriefKey, setIngestMsg);
  useTaskResult<string>(importResumeKey, setIngestMsg);
  useTaskResult<string>(createResumeKey, setIngestMsg);
  useTaskResult<string>(applyHistoryKey, setPlanMsg);
  useTaskResult<string>(planGenerateKey, setPlanMsg);
  const taskError =
    ingestWebTask.error ??
    ingestPastedTask.error ??
    ingestDebriefTask.error ??
    importResumeTask.error ??
    createResumeTask.error;
  const planError = applyHistoryTask.error ?? planTask.error;

  // filterDate 清空时渲染期同步清空 plan，避免 effect 内同步 setState
  if (prevCalendarFilterDate !== calendarFilterDate) {
    setPrevCalendarFilterDate(calendarFilterDate);
    if (!calendarFilterDate) setFilterPlan(null);
  }

  useEffect(() => {
    if (!calendarFilterDate) return;
    void invoke('plan:getToday', { campaignId: id, date: calendarFilterDate }).then(setFilterPlan);
  }, [id, calendarFilterDate, planLogKey]);

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
        if (a.kind !== 'note' && a.kind !== 'highlight' && a.kind !== 'elaboration') continue;
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

  useDataRefresh(refresh);

  useEffect(() => {
    if (!autoDiagnose || autoRan.current) return;
    autoRan.current = true;
    void invoke('diagnosis:fromJd', { campaignId: id });
  }, [id, autoDiagnose]);

  useEffect(() => {
    if (!job && lastResult) refresh();
  }, [job, lastResult, refresh]);

  // 细化任务结束时渲染期同步清空待展开节点
  if (!expandJob.isRunning && pendingExpandNodeId) {
    setPendingExpandNodeId(null);
  }

  const runDiagnosis = async (): Promise<void> => {
    await invoke('diagnosis:fromJd', { campaignId: id });
  };

  const attachResume = async (resumeId: string): Promise<void> => {
    await invoke('diagnosis:attachResume', { campaignId: id, resumeId });
  };

  /** 从文件导入简历到简历库；attach=true 时随即关联到当前战役并触发交叉分析 */
  const importResumeFile = (attach: boolean): void => {
    void runTask(importResumeKey, async () => {
      const r = await invoke('resume:importFile', undefined);
      if (!r) return '已取消导入';
      refresh();
      if (attach) await attachResume(r.id);
      return `已导入：${r.label}`;
    }).catch(() => undefined);
  };

  const createAndAttachResume = (): void => {
    if (!newResumeText.trim()) return;
    void runTask(createResumeKey, async () => {
      const r = await invoke('resume:create', {
        label: newResumeLabel.trim() || '我的简历',
        rawText: newResumeText.trim(),
      });
      await attachResume(r.id);
      return `已保存并交叉分析：${r.label}`;
    })
      .then(() => {
        setShowResumeForm(false);
        setNewResumeText('');
      })
      .catch(() => undefined);
  };

  const expandNode = async (nodeId: string): Promise<void> => {
    if (job) return;
    setPendingExpandNodeId(nodeId);
    try {
      await invoke('diagnosis:expandNode', { nodeId });
    } catch (err) {
      setPendingExpandNodeId(null);
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const fetchIntel = async (): Promise<void> => {
    await invoke('diagnosis:fetchIntel', { campaignId: id });
  };

  const ingestReport = (sourceType: 'pasted' | 'selfDebrief'): void => {
    const raw = sourceType === 'selfDebrief' ? debriefText : reportText;
    if (!raw.trim()) return;
    setIngestMsg(null);
    void runTask(
      sourceType === 'selfDebrief' ? ingestDebriefKey : ingestPastedKey,
      async () => {
        const res = await invoke('diagnosis:ingestReport', {
          campaignId: id,
          rawText: raw.trim(),
          sourceType,
        });
        refresh();
        return (
          `提取 ${res.questionsExtracted} 题，更新 ${res.nodesUpdated} 个考点` +
          (res.blindSpotsCreated ? `，新增 ${res.blindSpotsCreated} 个盲区考点` : '') +
          (res.crossCampaignUpdated ? `，跨 Campaign 修正 ${res.crossCampaignUpdated} 处` : '') +
          (res.unverifiedCount
            ? `；${res.corroboratedCount} 处多源印证、${res.unverifiedCount} 处单一来源（权重减半）`
            : '')
        );
      },
    )
      .then(() => {
        if (sourceType === 'selfDebrief') setDebriefText('');
        else setReportText('');
      })
      .catch(() => undefined);
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

  const applyHistory = (): void => {
    void runTask(applyHistoryKey, async () => {
      const res = await invoke('insight:applyHistory', { campaignId: id });
      setNudges(res.nudges);
      refresh();
      return res.boosted + res.eased === 0
        ? '历史信号暂无可回写的内容'
        : `已生成 ${res.boosted} 处提权、${res.eased} 处拆小，优先级已刷新`;
    }).catch(() => undefined);
  };

  const createChildNode = async (
    parentId: string,
    name: string,
    kind: NodeKind,
  ): Promise<void> => {
    await invoke('node:create', { campaignId: id, parentId, name, kind });
    refresh();
  };

  const ingestWeb = (): void => {
    setIngestMsg(null);
    void runTask(ingestWebKey, async () => {
      const res = await invoke('diagnosis:ingestWeb', { campaignId: id });
      refresh();
      return (
        `联网摄入 ${res.reports.length} 篇（抓取 ${res.sourcesFetched} 页），` +
        `提取 ${res.totalQuestions} 题，更新 ${res.totalNodesUpdated} 个考点`
      );
    }).catch(() => undefined);
  };

  const toggleBookmark = async (nodeId: string): Promise<void> => {
    await invoke('annotation:toggleBookmark', {
      targetType: 'node',
      targetId: nodeId,
    });
    refresh();
  };

  const generatePlan = async (): Promise<void> => {
    setPlanMsg(null);
    await runTask(planGenerateKey, async () => {
      const res = await invoke('plan:generate', {
        campaignId: id,
        interviewDate: interviewDate || undefined,
        dailyMinutes: Number(dailyMinutes) || 90,
      });
      setPlanLogKey((k) => k + 1);
      refresh();
      return (
        `已生成 ${res.daysCreated} 天计划、${res.tasksCreated} 个任务` +
        (res.overflowFallbacks ? `（含 ${res.overflowFallbacks} 个兜底话术）` : '')
      );
    }).catch(() => undefined);
  };

  const visibleNodeIds = useMemo(() => {
    if (!detail) return null;
    const calendarIds = calendarFilterDate && filterPlan ? nodeIdsForPlanFilter(detail.nodes, filterPlan.tasks) : null;
    const hasListFilter = statusFilter !== 'all' || markFilter !== 'all';
    if (!calendarIds && !hasListFilter) return null;

    const nodeMarkIds = new Set(
      annotations
        .filter(
          (a) =>
            a.targetType === 'node' &&
            (a.kind === 'note' || a.kind === 'highlight' || a.kind === 'elaboration'),
        )
        .map((a) => a.targetId),
    );
    const matched = detail.nodes
      .filter((n) => !calendarIds || calendarIds.has(n.id))
      .filter((n) => statusFilter === 'all' || n.status === statusFilter)
      .filter((n) => {
        if (markFilter === 'all') return true;
        if (markFilter === 'bookmarked') return bookmarkedIds.has(n.id);
        if (markFilter === 'marked') return nodeMarkIds.has(n.id);
        return n.id === lastNodeId;
      })
      .map((n) => n.id);

    const treeIds = hasListFilter ? nodeIdsForTreeFilter(detail.nodes, matched) : (calendarIds ?? new Set<string>());
    if (!calendarIds) return treeIds;
    return new Set([...treeIds].filter((nodeId) => calendarIds.has(nodeId)));
  }, [
    annotations,
    bookmarkedIds,
    calendarFilterDate,
    detail,
    filterPlan,
    lastNodeId,
    markFilter,
    statusFilter,
  ]);

  if (!detail) {
    return <p className="p-6 text-sm text-[var(--color-muted)]">加载中…</p>;
  }

  const { campaign, nodes, intel } = detail;
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const markCount = annotations.filter((a) => a.kind !== 'bookmark').length;
  const bookmarkCount = annotations.filter((a) => a.kind === 'bookmark').length;

  const jumpToNode = (nodeId: string): void => {
    setPageTab('study');
    setSelectedNodeId(nodeId);
    setNodeStudyMode('explain');
    setLastNodeId(nodeId);
    window.localStorage.setItem(`openjob:lastNode:${id}`, nodeId);
  };

  const openTaskInStudy = (task: TaskView): void => {
    if (!task.nodeId) return;
    setPageTab('study');
    setSelectedNodeId(task.nodeId);
    setNodeStudyMode(task.kind === 'drill' ? 'drill' : 'explain');
    setLastNodeId(task.nodeId);
    window.localStorage.setItem(`openjob:lastNode:${id}`, task.nodeId);
  };

  return (
    <PageShell fill className="overflow-hidden">
      <header className="shrink-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
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
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(job)}
              onClick={() => void runDiagnosis()}
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {jdJob.isRunning ? '诊断中…' : nodes.length ? '重新诊断' : '开始诊断'}
            </button>
          </div>
        </div>

        {(job || lastResult) && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs">
            {job && (
              <p className="text-sky-400">
                {job.label}：{job.message}
                {job.progress !== null ? ` (${Math.round(job.progress * 100)}%)` : ''}
              </p>
            )}
            {!job && lastResult?.error && (
              <p className="text-red-400">
                {lastResult.label}失败：{lastResult.error}
              </p>
            )}
            {!job && lastResult && !lastResult.error && (
              <p className="text-emerald-400">
                {lastResult.label}：{lastResult.message}
              </p>
            )}
          </div>
        )}

        <nav className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--color-border)]">
          <div className="flex gap-1">
            {(
              [
                { id: 'intel' as const, label: '情报与面经' },
                { id: 'study' as const, label: '学习' },
                {
                  id: 'materials' as const,
                  label: '资料与标记',
                  badge: markCount + bookmarkCount > 0 ? markCount + bookmarkCount : undefined,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPageTab(tab.id)}
                className={`relative -mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
                  pageTab === tab.id
                    ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
                    : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {tab.label}
                {'badge' in tab && tab.badge != null && (
                  <span className="ml-1.5 rounded-full bg-[var(--color-accent)]/20 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]">
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </nav>
      </header>

      <div className="mt-4 min-h-0 flex-1 overflow-hidden">
        {pageTab === 'intel' && (
          <div className="h-full space-y-4 overflow-y-auto pr-1">
            <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">公司情报</h3>
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    联网检索目标公司与岗位背景，可划词记笔记
                  </p>
                </div>
                <button
                  type="button"
                  disabled={Boolean(job)}
                  onClick={() => void fetchIntel()}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {intelJob.isRunning ? '生成中…' : intel ? '重新检索' : '生成公司情报'}
                </button>
              </div>
              <div className="mt-3">
                {intel ? (
                  <CompanyIntelCard intel={intel} onAnnotationChange={refresh} />
                ) : (
                  <p className="text-xs text-[var(--color-muted)]">
                    点击「生成公司情报」联网检索公司与岗位信息
                  </p>
                )}
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <h3 className="text-sm font-medium">面经摄入</h3>
                <p className="mt-1 text-xs text-[var(--color-muted)]">粘贴面经或联网搜索自动摄入</p>
                <div className="mt-3 space-y-2">
                  <button
                    type="button"
                    disabled={webIngesting || Boolean(job)}
                    onClick={ingestWeb}
                    className="rounded border border-sky-800 bg-sky-950/40 px-3 py-1.5 text-xs text-sky-300 disabled:opacity-40"
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
                    disabled={!reportText.trim() || ingestPastedTask.running || Boolean(job)}
                    onClick={() => ingestReport('pasted')}
                    className="rounded border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
                  >
                    {ingestPastedTask.running ? '摄入中…' : '摄入面经'}
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
                  {taskError && <p className="text-xs text-red-400">{taskError}</p>}
                </div>
              </section>

              <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4">
                <h3 className="text-sm font-medium text-emerald-300">面经复盘</h3>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  面完当天录入实际被问到的题，会自动标记 Campaign 为已复盘
                </p>
                <div className="mt-3 space-y-2">
                  <textarea
                    value={debriefText}
                    onChange={(e) => setDebriefText(e.target.value)}
                    rows={5}
                    className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                    placeholder="今天面试被问了什么？"
                  />
                  <button
                    type="button"
                    disabled={!debriefText.trim() || ingestDebriefTask.running || Boolean(job)}
                    onClick={() => ingestReport('selfDebrief')}
                    className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                  >
                    {ingestDebriefTask.running ? '提交中…' : '提交复盘'}
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}

        {pageTab === 'study' && (
          <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
            {detail.blindSpotQuestions.length > 0 && (
              <div className="shrink-0 rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-3">
                <p className="text-sm font-medium text-amber-300">
                  盲区真题 {detail.blindSpotQuestions.length} 道 — 建议优先补学
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-amber-100/70">
                  {detail.blindSpotQuestions.map((q) => q.questionText).join(' · ')}
                </p>
                <button
                  type="button"
                  onClick={() => setPageTab('materials')}
                  className="mt-2 text-xs text-amber-300 hover:underline"
                >
                  在资料页查看全部 →
                </button>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(320px,36%)_minmax(0,1fr)] xl:grid-cols-[minmax(360px,32%)_minmax(0,1fr)]">
                <div className="flex min-h-0 min-w-0 flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--color-muted)]">
                      考点清单
                      {calendarFilterDate && (
                        <button
                          type="button"
                          onClick={() => setCalendarFilterDate(null)}
                          className="ml-1 text-sky-400 hover:underline"
                        >
                          · {calendarFilterDate.slice(5)} ×
                        </button>
                      )}
                    </span>
                    <div className="relative flex items-center gap-2">
                      <span className="text-xs text-[var(--color-muted)]">{nodes.length} 个考点</span>
                      <button
                        type="button"
                        onClick={() => setShowEdges((v) => !v)}
                        className="text-xs text-sky-400 hover:underline"
                      >
                        {showEdges ? '收起关系' : '关系'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowGraph((v) => !v)}
                        className="text-xs text-sky-400 hover:underline"
                      >
                        {showGraph ? '清单' : '图谱'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCalendarOpen((v) => !v)}
                        className={`text-xs hover:underline ${
                          calendarFilterDate || calendarOpen
                            ? 'font-medium text-[var(--color-accent)]'
                            : 'text-sky-400'
                        }`}
                      >
                        日历{calendarFilterDate ? ` · ${calendarFilterDate.slice(5)}` : ''}
                      </button>
                      <StudyPlanCalendarPopover
                        open={calendarOpen}
                        onClose={() => setCalendarOpen(false)}
                        campaignId={id}
                        nodeCount={nodes.length}
                        interviewDate={interviewDate}
                        dailyMinutes={dailyMinutes}
                        onInterviewDateChange={setInterviewDate}
                        onDailyMinutesChange={setDailyMinutes}
                        planMsg={planError ?? planMsg}
                        planLogKey={planLogKey}
                        onGeneratePlan={generatePlan}
                        filterDate={calendarFilterDate}
                        onFilterDateChange={setCalendarFilterDate}
                        onOpenTask={openTaskInStudy}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg)] px-2 py-2">
                    <label className="flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
                      状态
                      <select
                        value={statusFilter}
                        onChange={(e) => {
                          setShowGraph(false);
                          setStatusFilter(e.target.value as NodeStatus | 'all');
                        }}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs text-[var(--color-fg)]"
                      >
                        <option value="all">全部</option>
                        <option value="todo">未开始</option>
                        <option value="learning">学习中</option>
                        <option value="shaky">不牢</option>
                        <option value="mastered">已掌握</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
                      标记
                      <select
                        value={markFilter}
                        onChange={(e) => {
                          setShowGraph(false);
                          setMarkFilter(e.target.value as 'all' | 'bookmarked' | 'marked' | 'last');
                        }}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs text-[var(--color-fg)]"
                      >
                        <option value="all">全部</option>
                        <option value="bookmarked">收藏</option>
                        <option value="marked">有笔记/高亮/细化</option>
                        <option value="last">上次学习</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!lastNodeId || !nodes.some((n) => n.id === lastNodeId)}
                      onClick={() => {
                        if (!lastNodeId) return;
                        setShowGraph(false);
                        setMarkFilter('last');
                        jumpToNode(lastNodeId);
                      }}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-sky-400 disabled:opacity-40"
                    >
                      继续上次
                    </button>
                    {(calendarFilterDate || statusFilter !== 'all' || markFilter !== 'all') && (
                      <button
                        type="button"
                        onClick={() => {
                          setCalendarFilterDate(null);
                          setStatusFilter('all');
                          setMarkFilter('all');
                        }}
                        className="ml-auto text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                      >
                        清空过滤
                      </button>
                    )}
                  </div>
                  {showEdges && (
                    <div className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                      <EdgeEditor
                        nodes={nodes}
                        edges={edges}
                        onCreate={(f, t, r) => void createEdge(f, t, r)}
                        onDelete={(eid) => void removeEdge(eid)}
                      />
                    </div>
                  )}
                  <div
                    className={`min-h-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 ${
                      showGraph ? 'flex flex-col overflow-hidden' : 'overflow-x-auto overflow-y-auto'
                    }`}
                  >
                    {showGraph ? (
                      <KnowledgeGraph nodes={nodes} edges={edges} />
                    ) : (
                      <KnowledgeTree
                        nodes={nodes}
                        bookmarkedIds={bookmarkedIds}
                        noteCountByNode={noteCounts}
                        visibleNodeIds={visibleNodeIds}
                        onExpand={(nid) => void expandNode(nid)}
                        onDelete={(nid) => void deleteNode(nid)}
                        onUpdate={(nid, patch) => void updateNode(nid, patch)}
                        onCreateChild={(pid, name, kind) => void createChildNode(pid, name, kind)}
                        onToggleBookmark={(nid) => void toggleBookmark(nid)}
                        onAddNote={(nid, note) => void addNote(nid, note)}
                        expandingId={expandJob.isRunning ? pendingExpandNodeId : null}
                        jobsBusy={Boolean(job)}
                        selectedNodeId={selectedNodeId}
                        onSelectNode={jumpToNode}
                      />
                    )}
                  </div>
                  {(expandJob.message || expandJob.error) && (
                    <p className={`text-xs ${expandJob.error ? 'text-red-400' : 'text-emerald-400'}`}>
                      细化考点：{expandJob.error ?? expandJob.message}
                    </p>
                  )}
                </div>

                <div className="flex min-h-0 flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                      {selectedNode ? (
                        <>
                          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
                            <span className="text-sm font-medium">{selectedNode.name}</span>
                            <span className="text-[10px] text-[var(--color-muted)]">
                              {selectedNode.coverageType} · 掌握 {selectedNode.mastery}/5
                            </span>
                            <div className="ml-auto flex gap-1">
                              <button
                                type="button"
                                onClick={() => setNodeStudyMode('explain')}
                                className={`rounded px-2 py-0.5 text-xs ${
                                  nodeStudyMode === 'explain'
                                    ? 'bg-[var(--color-accent)] text-white'
                                    : 'text-[var(--color-muted)]'
                                }`}
                              >
                                讲解
                              </button>
                              <button
                                type="button"
                                onClick={() => setNodeStudyMode('drill')}
                                className={`rounded px-2 py-0.5 text-xs ${
                                  nodeStudyMode === 'drill'
                                    ? 'bg-[var(--color-accent)] text-white'
                                    : 'text-[var(--color-muted)]'
                                }`}
                              >
                                考我
                              </button>
                              <button
                                type="button"
                                onClick={() => setNodeStudyMode('followUp')}
                                className={`rounded px-2 py-0.5 text-xs ${
                                  nodeStudyMode === 'followUp'
                                    ? 'bg-[var(--color-accent)] text-white'
                                    : 'text-[var(--color-muted)]'
                                }`}
                              >
                                追问
                              </button>
                            </div>
                          </div>
                          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
                            {nodeStudyMode === 'drill' ? (
                              <div className="min-h-0 flex-1 overflow-y-auto">
                                <QuizPanel nodeId={selectedNode.id} nodeName={selectedNode.name} />
                              </div>
                            ) : nodeStudyMode === 'followUp' ? (
                              <NodeFollowUpChat
                                campaignId={id}
                                nodeId={selectedNode.id}
                                nodeName={selectedNode.name}
                              />
                            ) : (
                              <div className="min-h-0 flex-1 overflow-y-auto">
                                <TaskStudyPanel
                                  nodeId={selectedNode.id}
                                  nodeName={selectedNode.name}
                                  onAnnotationChange={refresh}
                                />
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                          <p className="text-sm text-[var(--color-muted)]">点击左侧考点开始学习</p>
                          <p className="text-xs text-[var(--color-muted)]">
                            细化出的新考点可直接点学，无需等排程
                          </p>
                        </div>
                      )}
                    </div>
                </div>
              </div>
            </div>
        )}

        {pageTab === 'materials' && (
          <div className="h-full space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-medium">我的标记</h3>
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    讲解、真题、情报上的高亮与笔记汇总；点击知识点可跳回学习
                  </p>
                </div>
                {markCount + bookmarkCount > 0 && (
                  <span className="text-xs text-[var(--color-muted)]">
                    {markCount} 条标记 · {bookmarkCount} 个收藏
                  </span>
                )}
              </div>
              <AnnotationDigest
                annotations={annotations}
                onChange={refresh}
                onJumpToNode={jumpToNode}
                layout="wide"
              />
              </section>

              <div className="space-y-4">
                <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <h3 className="text-sm font-medium">该提醒你的事</h3>
                  <div className="mt-3">
                    <NudgePanel
                      nudges={nudges}
                      applying={applyingHistory}
                      onApplyHistory={applyHistory}
                    />
                  </div>
                </section>

                <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <h3 className="text-sm font-medium">简历</h3>
                <div className="mt-3 space-y-2">
                  {resumeJob.isRunning && (
                    <p className="text-xs text-sky-400">简历交叉分析中… {resumeJob.statusMessage}</p>
                  )}
                  {resumeJob.error && <p className="text-xs text-red-400">{resumeJob.error}</p>}
                  {resumeJob.message && !resumeJob.isRunning && (
                    <p className="text-xs text-emerald-400">{resumeJob.message}</p>
                  )}
                  {detail.resume ? (
                    <>
                      <p className="text-xs text-emerald-400">已关联：{detail.resume.label}</p>
                      <button
                        type="button"
                        disabled={importingResume}
                        onClick={() => importResumeFile(true)}
                        className="text-xs text-sky-400 hover:underline disabled:opacity-40"
                      >
                        {importingResume ? '导入中…' : '从文件导入以替换'}
                      </button>
                    </>
                  ) : (
                    <>
                      {resumes.length > 0 && (
                        <select
                          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm disabled:opacity-40"
                          defaultValue=""
                          disabled={Boolean(job)}
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
                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={importingResume}
                          onClick={() => importResumeFile(true)}
                          className="text-xs text-sky-400 hover:underline disabled:opacity-40"
                        >
                          {importingResume ? '导入中…' : '从文件导入'}
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
                            rows={5}
                            placeholder="粘贴简历全文…"
                            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                          />
                          <button
                            type="button"
                            disabled={createResumeTask.running || Boolean(job)}
                            onClick={createAndAttachResume}
                            className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white disabled:opacity-40"
                          >
                            {createResumeTask.running ? '保存中…' : '保存并交叉分析'}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
              </div>
            </div>

            {detail.blindSpotQuestions.length > 0 && (
              <section className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
                <h3 className="text-sm font-medium text-amber-300">
                  盲区真题（{detail.blindSpotQuestions.length}）
                </h3>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  图谱未能预测到的题目，信息价值最高
                </p>
                <ul className="mt-3 space-y-3">
                  {detail.blindSpotQuestions.map((q) => (
                    <li key={q.id} className="rounded-lg border border-amber-900/30 bg-black/20 p-3">
                      <p className="text-sm text-amber-100/90">{q.questionText}</p>
                      <div className="mt-2">
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
              </section>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}
