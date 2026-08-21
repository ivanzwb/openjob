import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  CampaignDetail,
  CampaignOverview,
  CampaignSummary,
  PlanDateOption,
  SpeechSnippetView,
  TodayCampaignOption,
  TodayPlan,
  TaskView,
  SessionSummary,
  SessionMessageView,
} from '@shared/ipc';
import type { Repo as RepoEntity } from '@shared/entities';
import type { FollowUpMessage } from './mutations';
import type {
  FollowUpStoredMessage,
  FollowUpSummaryState,
} from '@shared/llm/followUpContext';

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function listCampaigns(db: SQLiteDatabase): CampaignSummary[] {
  const rows = db.getAllSync<{
    id: string;
    company: string;
    role_title: string;
    status: string;
    interview_date: string | null;
    resume_id: string | null;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM campaign ORDER BY updated_at DESC`);

  return rows.map((row) => {
    const count = db.getFirstSync<{ n: number }>(
      `SELECT count(*) AS n FROM knowledge_node WHERE campaign_id = ?`,
      row.id,
    );
    return {
      id: row.id,
      company: row.company,
      roleTitle: row.role_title,
      status: row.status as CampaignSummary['status'],
      interviewDate: row.interview_date,
      nodeCount: count?.n ?? 0,
      hasResume: Boolean(row.resume_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function listSpeechSnippets(db: SQLiteDatabase): SpeechSnippetView[] {
  const rows = db.getAllSync<{
    id: string;
    source_type: string;
    source_id: string;
    tier: string;
    content_md: string;
    is_user_edited: number;
    created_at: number;
  }>(`SELECT * FROM speech_snippet ORDER BY created_at DESC`);

  return rows.map((row) => {
    const sourceType = row.source_type as SpeechSnippetView['sourceType'];
    return {
      id: row.id,
      sourceType,
      sourceId: row.source_id,
      tier: row.tier as SpeechSnippetView['tier'],
      contentMd: row.content_md,
      isUserEdited: Boolean(row.is_user_edited),
      createdAt: row.created_at,
      sourceLabel: resolveSpeechSourceLabel(db, sourceType, row.source_id),
    };
  });
}

export function getNodeAnnotationSummary(
  db: SQLiteDatabase,
  campaignId: string,
): { bookmarkedIds: Set<string>; markedIds: Set<string> } {
  const nodeIds = new Set(
    db
      .getAllSync<{ id: string }>(`SELECT id FROM knowledge_node WHERE campaign_id = ?`, campaignId)
      .map((row) => row.id),
  );
  if (nodeIds.size === 0) return { bookmarkedIds: new Set(), markedIds: new Set() };

  const rows = db.getAllSync<{ target_id: string; kind: string }>(
    `SELECT target_id, kind FROM annotation WHERE target_type = 'node'`,
  );
  const bookmarkedIds = new Set<string>();
  const markedIds = new Set<string>();
  for (const row of rows) {
    if (!nodeIds.has(row.target_id)) continue;
    if (row.kind === 'bookmark') bookmarkedIds.add(row.target_id);
    if (row.kind === 'note' || row.kind === 'highlight' || row.kind === 'elaboration') {
      markedIds.add(row.target_id);
    }
  }
  return { bookmarkedIds, markedIds };
}

function resolveSpeechSourceLabel(
  db: SQLiteDatabase,
  sourceType: SpeechSnippetView['sourceType'],
  sourceId: string,
): string {
  if (sourceType === 'codeRef') {
    const repo = db.getFirstSync<{ url: string }>(`SELECT url FROM repo WHERE id = ?`, sourceId);
    return repo ? `源码 · ${repo.url.replace(/^https?:\/\//, '')}` : '源码';
  }
  if (sourceType === 'node') {
    const node = db.getFirstSync<{ name: string }>(`SELECT name FROM knowledge_node WHERE id = ?`, sourceId);
    return node ? `考点 · ${node.name}` : '考点';
  }
  if (sourceType === 'quiz') {
    const attempt = db.getFirstSync<{ node_id: string }>(
      `SELECT node_id FROM quiz_attempt WHERE id = ?`,
      sourceId,
    );
    if (!attempt) return '考我';
    const node = db.getFirstSync<{ name: string }>(
      `SELECT name FROM knowledge_node WHERE id = ?`,
      attempt.node_id,
    );
    return node ? `考我 · ${node.name}` : '考我';
  }
  if (sourceType === 'design') {
    const campaign = db.getFirstSync<{ company: string }>(
      `SELECT company FROM campaign WHERE id = ?`,
      sourceId,
    );
    return campaign ? `模拟面试 · ${campaign.company}` : '模拟面试';
  }
  return '话术';
}

export function listTodayCampaigns(db: SQLiteDatabase): TodayCampaignOption[] {
  const today = todayLocal();
  return listCampaigns(db)
    .filter((c) => c.status === 'active' || c.status === 'planning')
    .map((c) => {
      const planDay = db.getFirstSync<{ id: string }>(
        `SELECT id FROM plan_day WHERE campaign_id = ? AND date = ?`,
        c.id,
        today,
      );
      if (!planDay) {
        return {
          id: c.id,
          company: c.company,
          roleTitle: c.roleTitle,
          status: c.status,
          hasPlanToday: false,
          completedCount: 0,
          totalCount: 0,
        };
      }
      const tasks = db.getAllSync<{ status: string }>(
        `SELECT status FROM task WHERE plan_day_id = ?`,
        planDay.id,
      );
      return {
        id: c.id,
        company: c.company,
        roleTitle: c.roleTitle,
        status: c.status,
        hasPlanToday: true,
        completedCount: tasks.filter((t) => t.status === 'done').length,
        totalCount: tasks.length,
      };
    });
}

export function listPlanDates(db: SQLiteDatabase, campaignId: string): PlanDateOption[] {
  const days = db.getAllSync<{ id: string; date: string }>(
    `SELECT id, date FROM plan_day WHERE campaign_id = ? ORDER BY date ASC`,
    campaignId,
  );
  return days.map((d) => {
    const count = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) as c FROM task WHERE plan_day_id = ?`,
      d.id,
    );
    return { date: d.date, taskCount: count?.c ?? 0 };
  });
}

export function getTodayPlan(db: SQLiteDatabase, campaignId?: string, date?: string): TodayPlan | null {
  let id = campaignId;
  if (!id) {
    const active = db.getAllSync<{ id: string; updated_at: number }>(
      `SELECT id, updated_at FROM campaign WHERE status = 'active'`,
    );
    if (!active.length) return null;
    id = active.sort((a, b) => b.updated_at - a.updated_at)[0]!.id;
  }

  const campaign = db.getFirstSync<{
    id: string;
    company: string;
    role_title: string;
  }>(`SELECT id, company, role_title FROM campaign WHERE id = ?`, id);
  if (!campaign) return null;

  const targetDate = date ?? todayLocal();
  const planDay = db.getFirstSync<{
    id: string;
    campaign_id: string;
    date: string;
    planned_minutes: number;
    status: string;
  }>(`SELECT * FROM plan_day WHERE campaign_id = ? AND date = ?`, id, targetDate);

  if (!planDay) {
    return {
      campaignId: id,
      company: campaign.company,
      roleTitle: campaign.role_title,
      date: targetDate,
      planDay: null,
      tasks: [],
      completedCount: 0,
      totalCount: 0,
      plannedMinutes: 0,
    };
  }

  const taskRows = db.getAllSync<{
    id: string;
    plan_day_id: string;
    node_id: string | null;
    repo_id: string | null;
    kind: string;
    est_minutes: number;
    actual_minutes: number | null;
    status: string;
    order_idx: number;
  }>(`SELECT * FROM task WHERE plan_day_id = ? ORDER BY order_idx ASC`, planDay.id);

  const tasks: TaskView[] = taskRows.map((t) => {
    const node = t.node_id
      ? db.getFirstSync<{ name: string; coverage_type: string }>(
          `SELECT name, coverage_type FROM knowledge_node WHERE id = ?`,
          t.node_id,
        )
      : null;
    const repo = t.repo_id
      ? db.getFirstSync<{ url: string }>(`SELECT url FROM repo WHERE id = ?`, t.repo_id)
      : null;
    return {
      id: t.id,
      planDayId: t.plan_day_id,
      nodeId: t.node_id,
      repoId: t.repo_id,
      kind: t.kind as TaskView['kind'],
      estMinutes: t.est_minutes,
      actualMinutes: t.actual_minutes,
      status: t.status as TaskView['status'],
      orderIdx: t.order_idx,
      nodeName: node?.name ?? null,
      nodeCoverage: (node?.coverage_type as TaskView['nodeCoverage']) ?? null,
      repoUrl: repo?.url ?? null,
    };
  });

  const completedCount = tasks.filter((t) => t.status === 'done').length;
  return {
    campaignId: id,
    company: campaign.company,
    roleTitle: campaign.role_title,
    date: targetDate,
    planDay: {
      id: planDay.id,
      campaignId: planDay.campaign_id,
      date: planDay.date,
      plannedMinutes: planDay.planned_minutes,
      status: planDay.status as TodayPlan['planDay'] extends infer P
        ? P extends { status: infer S }
          ? S
          : never
        : never,
    },
    tasks,
    completedCount,
    totalCount: tasks.length,
    plannedMinutes: planDay.planned_minutes,
  };
}

export function getCampaignDetail(db: SQLiteDatabase, id: string): CampaignDetail {
  const row = db.getFirstSync<{
    id: string;
    company: string;
    role_title: string;
    jd_raw: string;
    jd_parsed: string | null;
    job_target_id: string | null;
    resume_id: string | null;
    interview_date: string | null;
    daily_minutes: number | null;
    status: string;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM campaign WHERE id = ?`, id);
  if (!row) throw new Error('Campaign 不存在');

  const explanationNodeIds = new Set(
    db
      .getAllSync<{ node_id: string }>(
        `SELECT DISTINCT e.node_id
         FROM explanation e
         INNER JOIN knowledge_node kn ON kn.id = e.node_id
         WHERE kn.campaign_id = ?`,
        id,
      )
      .map((item) => item.node_id),
  );

  const nodes = db
    .getAllSync<{
      id: string;
      campaign_id: string;
      parent_id: string | null;
      name: string;
      kind: string;
      coverage_type: string;
      exam_prob: number;
      difficulty: number;
      est_minutes: number;
      exam_forms: string;
      mastery: number;
      mastery_source: string;
      priority_score: number;
      status: string;
      is_user_added: number;
      created_at: number;
    }>(`SELECT * FROM knowledge_node WHERE campaign_id = ? ORDER BY priority_score DESC`, id)
    .map((n) => ({
      id: n.id,
      campaignId: n.campaign_id,
      parentId: n.parent_id,
      name: n.name,
      kind: n.kind as CampaignDetail['nodes'][number]['kind'],
      coverageType: n.coverage_type as CampaignDetail['nodes'][number]['coverageType'],
      examProb: n.exam_prob,
      difficulty: n.difficulty,
      estMinutes: n.est_minutes,
      examForms: JSON.parse(n.exam_forms) as CampaignDetail['nodes'][number]['examForms'],
      mastery: n.mastery,
      masterySource: n.mastery_source as CampaignDetail['nodes'][number]['masterySource'],
      priorityScore: n.priority_score,
      status: n.status as CampaignDetail['nodes'][number]['status'],
      isUserAdded: Boolean(n.is_user_added),
      createdAt: n.created_at,
      priorityReason: '',
      hasExplanation: explanationNodeIds.has(n.id),
    }));

  const intel = db.getFirstSync<{
    id: string;
    campaign_id: string;
    tech_stack_md: string;
    interview_process_md: string;
    hot_topics_md: string;
    talking_points_md: string;
    source_ids: string;
    updated_at: number;
  }>(`SELECT * FROM company_intel WHERE campaign_id = ?`, id);

  const reportCount =
    db.getFirstSync<{ n: number }>(
      `SELECT count(*) AS n FROM interview_report WHERE campaign_id = ?`,
      id,
    )?.n ?? 0;

  return {
    campaign: {
      id: row.id,
      company: row.company,
      roleTitle: row.role_title,
      jdRaw: row.jd_raw,
      jdParsed: row.jd_parsed ? JSON.parse(row.jd_parsed) : null,
      jobTargetId: row.job_target_id,
      resumeId: row.resume_id,
      interviewDate: row.interview_date,
      dailyMinutes: row.daily_minutes,
      status: row.status as CampaignDetail['campaign']['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    resume: null,
    nodes,
    intel: intel
      ? {
          id: intel.id,
          campaignId: intel.campaign_id,
          techStackMd: intel.tech_stack_md,
          interviewProcessMd: intel.interview_process_md,
          hotTopicsMd: intel.hot_topics_md,
          talkingPointsMd: intel.talking_points_md,
          sourceIds: JSON.parse(intel.source_ids) as string[],
          updatedAt: intel.updated_at,
        }
      : null,
    reportCount,
    blindSpotQuestions: [],
    historicalPriorCampaigns: 0,
  };
}

export function getCampaignOverview(db: SQLiteDatabase): CampaignOverview {
  const campaigns = listCampaigns(db);

  const totalSpeechSnippets =
    db.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM speech_snippet`)?.n ?? 0;

  const totalBlindSpots =
    db.getFirstSync<{ n: number }>(
      `SELECT count(*) AS n FROM interview_question WHERE is_blind_spot = 1`,
    )?.n ?? 0;

  const nodeRows = db.getAllSync<{
    id: string;
    campaign_id: string;
    name: string;
    mastery: number;
    company: string;
    role_title: string;
  }>(
    `SELECT kn.id, kn.campaign_id, kn.name, kn.mastery, c.company, c.role_title
     FROM knowledge_node kn
     INNER JOIN campaign c ON c.id = kn.campaign_id`,
  );

  const weakNodes = nodeRows
    .filter((n) => n.mastery < 3)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 12)
    .map((n) => ({
      campaignId: n.campaign_id,
      company: n.company,
      roleTitle: n.role_title,
      nodeId: n.id,
      nodeName: n.name,
      mastery: n.mastery,
    }));

  const reportRows = db.getAllSync<{ company: string; campaign_id: string | null }>(
    `SELECT company, campaign_id FROM interview_report`,
  );

  const byCompany = new Map<string, { campaignIds: Set<string>; reportCount: number }>();
  for (const r of reportRows) {
    const entry = byCompany.get(r.company) ?? { campaignIds: new Set(), reportCount: 0 };
    entry.reportCount++;
    if (r.campaign_id) entry.campaignIds.add(r.campaign_id);
    byCompany.set(r.company, entry);
  }

  const priorByCompany = [...byCompany.entries()]
    .map(([company, v]) => ({
      company,
      campaignCount: v.campaignIds.size,
      reportCount: v.reportCount,
    }))
    .sort((a, b) => b.reportCount - a.reportCount);

  const avgMastery =
    nodeRows.length > 0
      ? nodeRows.reduce((s, n) => s + n.mastery, 0) / nodeRows.length
      : 0;

  return {
    campaignCount: campaigns.length,
    activeCampaignCount: campaigns.filter((c) => c.status === 'active').length,
    totalSpeechSnippets,
    totalBlindSpots,
    avgMastery,
    campaigns,
    weakNodes,
    priorByCompany,
  };
}

export function listRepos(db: SQLiteDatabase): RepoEntity[] {
  return db
    .getAllSync<{
      id: string;
      url: string;
      local_path: string;
      default_branch: string | null;
      commit_sha: string | null;
      languages: string;
      repo_map_md: string | null;
      summary_md: string | null;
      indexed_at: number | null;
      status: string;
    }>(`SELECT * FROM repo ORDER BY url ASC`)
    .map((r) => ({
      id: r.id,
      url: r.url,
      localPath: r.local_path,
      defaultBranch: r.default_branch,
      commitSha: r.commit_sha,
      languages: JSON.parse(r.languages) as string[],
      repoMapMd: r.repo_map_md,
      summaryMd: r.summary_md,
      indexedAt: r.indexed_at,
      status: r.status as RepoEntity['status'],
    }));
}

export function listSessions(db: SQLiteDatabase, limit = 30): SessionSummary[] {
  return db
    .getAllSync<{
      id: string;
      campaign_id: string | null;
      node_id: string | null;
      kind: string;
      title: string;
      created_at: number;
    }>(`SELECT * FROM session ORDER BY created_at DESC LIMIT ?`, limit)
    .map((s) => ({
      id: s.id,
      campaignId: s.campaign_id,
      nodeId: s.node_id,
      kind: s.kind as SessionSummary['kind'],
      title: s.title,
      createdAt: s.created_at,
      messageCount: db.getFirstSync<{ n: number }>(
        `SELECT count(*) AS n FROM message WHERE session_id = ?`,
        s.id,
      )?.n ?? 0,
      totalTokens: 0,
    }));
}

export function getNodeFollowUpHistory(
  db: SQLiteDatabase,
  nodeId: string,
): FollowUpMessage[] {
  return db
    .getAllSync<{ role: string; content_md: string }>(
      `SELECT message.role, message.content_md
       FROM message
       INNER JOIN session ON session.id = message.session_id
       WHERE session.node_id = ?
         AND session.kind = 'nodeFollowUp'
         AND message.role IN ('user', 'assistant')
       ORDER BY message.created_at ASC, message.id ASC`,
      nodeId,
    )
    .map((message) => ({
      role: message.role as FollowUpMessage['role'],
      text: message.content_md,
    }));
}

export function getNodeFollowUpContext(
  db: SQLiteDatabase,
  nodeId: string,
): {
  sessionId: string;
  state: FollowUpSummaryState;
  messages: FollowUpStoredMessage[];
} {
  const current = db.getFirstSync<{
    id: string;
    context_summary_md: string;
    context_summary_through_id: string | null;
    context_summary_source_count: number;
  }>(
    `SELECT id, context_summary_md, context_summary_through_id,
            context_summary_source_count
     FROM session
     WHERE node_id = ? AND kind = 'nodeFollowUp'
     ORDER BY created_at DESC LIMIT 1`,
    nodeId,
  );
  if (!current) throw new Error('追问会话不存在');

  const messages = db
    .getAllSync<{
      id: string;
      role: string;
      content_md: string;
    }>(
      `SELECT message.id, message.role, message.content_md
       FROM message
       INNER JOIN session ON session.id = message.session_id
       WHERE session.node_id = ?
         AND session.kind = 'nodeFollowUp'
         AND message.role IN ('user', 'assistant')
       ORDER BY message.created_at ASC, message.id ASC`,
      nodeId,
    )
    .map((message) => ({
      id: message.id,
      role: message.role as FollowUpStoredMessage['role'],
      content: message.content_md,
    }));
  return {
    sessionId: current.id,
    state: {
      summary: current.context_summary_md,
      throughMessageId: current.context_summary_through_id,
      sourceCount: current.context_summary_source_count,
    },
    messages,
  };
}

export function getSessionMessages(db: SQLiteDatabase, sessionId: string): SessionMessageView[] {
  return db
    .getAllSync<{
      id: string;
      session_id: string;
      role: string;
      content_md: string;
      citations: string;
      evidence_kind: string | null;
      created_at: number;
    }>(`SELECT * FROM message WHERE session_id = ? ORDER BY created_at ASC`, sessionId)
    .map((m) => ({
      id: m.id,
      sessionId: m.session_id,
      role: m.role as SessionMessageView['role'],
      contentMd: m.content_md,
      citations: JSON.parse(m.citations),
      usage: null,
      evidenceKind: m.evidence_kind as SessionMessageView['evidenceKind'],
      toolCalls: [],
      createdAt: m.created_at,
    }));
}
