import { randomUUID } from 'node:crypto';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import type {
  Campaign,
  JdParsed,
  KnowledgeNode,
  Resume,
  ResumeParsed,
} from '@shared/entities';
import type {
  CampaignDetail,
  CampaignSummary,
  CreateCampaignInput,
  KnowledgeNodeView,
  UpdateCampaignInput,
  UpdateResumeInput,
  BlindSpotQuestion,
} from '@shared/ipc';
import { structureResumeText } from '@shared/resume/importStructure';
import { getDb, schema } from '../db';
import { attachPriorityReason, computePriority } from '../diagnosis/priority';
import { countCrossCampaignReports } from '../diagnosis/prior';
import { sortNodesByStudyOrder } from './edges';
import { createJobTarget, getJobTarget, updateJobTarget } from '../jobTarget/repository';

function rowToCampaign(row: typeof schema.campaign.$inferSelect): Campaign {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.roleTitle,
    jdRaw: row.jdRaw,
    jdParsed: row.jdParsed ?? null,
    jobTargetId: row.jobTargetId,
    resumeId: row.resumeId,
    interviewDate: row.interviewDate,
    dailyMinutes: row.dailyMinutes,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToResume(row: typeof schema.resume.$inferSelect): Resume {
  return {
    id: row.id,
    label: row.label,
    rawText: row.rawText,
    parsed: row.parsed ?? null,
    previewStyle: row.previewStyle ?? null,
    photo: row.photo ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

function rowToNode(row: typeof schema.knowledgeNode.$inferSelect): KnowledgeNode {
  return {
    id: row.id,
    campaignId: row.campaignId,
    parentId: row.parentId,
    name: row.name,
    kind: row.kind,
    coverageType: row.coverageType,
    examProb: row.examProb,
    difficulty: row.difficulty,
    estMinutes: row.estMinutes,
    examForms: row.examForms,
    mastery: row.mastery,
    masterySource: row.masterySource,
    priorityScore: row.priorityScore,
    status: row.status,
    isUserAdded: row.isUserAdded,
    quizQuestionMd: row.quizQuestionMd ?? null,
    quizRecommendedAnswerMd: row.quizRecommendedAnswerMd ?? null,
    createdAt: row.createdAt,
  };
}

export function listCampaigns(): CampaignSummary[] {
  const db = getDb();
  const rows = db.select().from(schema.campaign).orderBy(desc(schema.campaign.updatedAt)).all();

  return rows.map((row) => {
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.campaignId, row.id))
      .get();
    return {
      id: row.id,
      company: row.company,
      roleTitle: row.roleTitle,
      status: row.status,
      interviewDate: row.interviewDate,
      nodeCount: count?.n ?? 0,
      hasResume: Boolean(row.resumeId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

export function getCampaignDetail(id: string): CampaignDetail {
  const db = getDb();
  const row = db.select().from(schema.campaign).where(eq(schema.campaign.id, id)).get();
  if (!row) throw new Error('Campaign 不存在');

  const campaign = rowToCampaign(row);
  const resume = campaign.resumeId
    ? db
        .select()
        .from(schema.resume)
        .where(eq(schema.resume.id, campaign.resumeId))
        .get()
    : null;

  // 考点清单按“备考顺序”展示：难度基础→深入、同等难度优先级高的靠前，
  // 再按 prerequisite 拓扑重排（前置在前）——与今日排程使用同一口径（sortNodesByStudyOrder）
  const nodeRows = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, id))
    .all();

  const edgeRows = db
    .select()
    .from(schema.nodeEdge)
    .where(
      inArray(
        schema.nodeEdge.fromNodeId,
        nodeRows.map((n) => n.id),
      ),
    )
    .all();

  const orderedNodes = sortNodesByStudyOrder(nodeRows, edgeRows);
  const explanationNodeIds =
    nodeRows.length > 0
      ? new Set(
          db
            .select({ nodeId: schema.explanation.nodeId })
            .from(schema.explanation)
            .where(
              inArray(
                schema.explanation.nodeId,
                nodeRows.map((n) => n.id),
              ),
            )
            .all()
            .map((row) => row.nodeId),
        )
      : new Set<string>();

  const nodes: KnowledgeNodeView[] = orderedNodes.map((n) =>
    {
      const node = attachPriorityReason(rowToNode(n));
      return { ...node, hasExplanation: explanationNodeIds.has(node.id) };
    },
  );

  const intel =
    db
      .select()
      .from(schema.companyIntel)
      .where(eq(schema.companyIntel.campaignId, id))
      .get() ?? null;

  const reportCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.interviewReport)
      .where(eq(schema.interviewReport.campaignId, id))
      .get()?.n ?? 0;

  const blindSpotRows = db
    .select({
      id: schema.interviewQuestion.id,
      questionText: schema.interviewQuestion.questionText,
      reportedAt: schema.interviewReport.reportedAt,
    })
    .from(schema.interviewQuestion)
    .innerJoin(
      schema.interviewReport,
      eq(schema.interviewQuestion.reportId, schema.interviewReport.id),
    )
    .where(
      and(
        eq(schema.interviewQuestion.isBlindSpot, true),
        eq(schema.interviewReport.campaignId, id),
      ),
    )
    .all();

  const blindSpotQuestions: BlindSpotQuestion[] = blindSpotRows.map((r) => ({
    id: r.id,
    questionText: r.questionText,
    reportedAt: r.reportedAt,
  }));

  const historicalPriorCampaigns = countCrossCampaignReports(campaign.company);

  return {
    campaign,
    resume: resume ? rowToResume(resume) : null,
    nodes,
    intel: intel
      ? {
          id: intel.id,
          campaignId: intel.campaignId,
          techStackMd: intel.techStackMd,
          interviewProcessMd: intel.interviewProcessMd,
          hotTopicsMd: intel.hotTopicsMd,
          talkingPointsMd: intel.talkingPointsMd,
          sourceIds: intel.sourceIds,
          updatedAt: intel.updatedAt,
        }
      : null,
    reportCount,
    blindSpotQuestions,
    historicalPriorCampaigns,
  };
}

export function createCampaign(input: CreateCampaignInput): Campaign {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();

  let jobTargetId = input.jobTargetId ?? null;
  let company = input.company?.trim() ?? '';
  let roleTitle = input.roleTitle?.trim() ?? '未命名岗位';
  let jdRaw = input.jdRaw?.trim() ?? '';
  let jdParsed: JdParsed | null;

  if (jobTargetId) {
    const t = getJobTarget(jobTargetId);
    company = t.company;
    roleTitle = t.roleTitle;
    jdRaw = t.jdRaw;
    jdParsed = t.jdParsed;
  } else if (company && jdRaw) {
    const t = createJobTarget({ company, roleTitle, jdRaw });
    jobTargetId = t.id;
    jdParsed = t.jdParsed;
  } else {
    throw new Error('请选择目标岗位，或填写公司与 JD');
  }

  const row = {
    id,
    company,
    roleTitle,
    jdRaw,
    jdParsed,
    jobTargetId,
    resumeId: null,
    interviewDate: null,
    dailyMinutes: null,
    status: 'planning' as const,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.campaign).values(row).run();
  return rowToCampaign(row);
}

export function updateCampaign(input: UpdateCampaignInput): Campaign {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.campaign)
    .where(eq(schema.campaign.id, input.id))
    .get();
  if (!existing) throw new Error('Campaign 不存在');

  const patch = {
    company: input.company?.trim() ?? existing.company,
    roleTitle: input.roleTitle?.trim() ?? existing.roleTitle,
    jdRaw: input.jdRaw?.trim() ?? existing.jdRaw,
    resumeId: input.resumeId !== undefined ? input.resumeId : existing.resumeId,
    interviewDate:
      input.interviewDate !== undefined ? input.interviewDate : existing.interviewDate,
    dailyMinutes:
      input.dailyMinutes !== undefined ? input.dailyMinutes : existing.dailyMinutes,
    status: input.status ?? existing.status,
    updatedAt: Date.now(),
  };

  if (
    existing.jobTargetId &&
    (patch.company !== existing.company ||
      patch.roleTitle !== existing.roleTitle ||
      patch.jdRaw !== existing.jdRaw)
  ) {
    updateJobTarget({
      id: existing.jobTargetId,
      company: patch.company,
      roleTitle: patch.roleTitle,
      jdRaw: patch.jdRaw,
    });
  }

  db.update(schema.campaign).set(patch).where(eq(schema.campaign.id, input.id)).run();
  return rowToCampaign({ ...existing, ...patch });
}

export function deleteCampaign(id: string): void {
  getDb().delete(schema.campaign).where(eq(schema.campaign.id, id)).run();
}

export function listResumes(): Resume[] {
  return getDb()
    .select()
    .from(schema.resume)
    .orderBy(desc(schema.resume.createdAt))
    .all()
    .map(rowToResume);
}

export function createResume(label: string, rawText: string): Resume {
  const db = getDb();
  const now = Date.now();
  const row = {
    id: randomUUID(),
    label: label.trim(),
    // 导入与粘贴进来的是没有结构的纯文本，先识别成模块，编辑器才能按模块填表
    rawText: structureResumeText(rawText),
    parsed: null,
    previewStyle: null,
    photo: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.resume).values(row).run();
  return rowToResume(row);
}

export function updateResume(input: UpdateResumeInput): Resume {
  const db = getDb();
  const existing = db.select().from(schema.resume).where(eq(schema.resume.id, input.id)).get();
  if (!existing) throw new Error('简历不存在');
  const now = Date.now();
  const patch = {
    label: input.label?.trim() ?? existing.label,
    rawText: input.rawText?.trim() ?? existing.rawText,
    previewStyle: input.previewStyle ?? existing.previewStyle,
    // 移除照片要能写进去，所以只认 undefined 为「不动」
    photo: input.photo !== undefined ? input.photo : existing.photo,
    updatedAt: now,
  };
  db.update(schema.resume).set(patch).where(eq(schema.resume.id, input.id)).run();
  return rowToResume({ ...existing, ...patch });
}

export function deleteResume(id: string): void {
  const db = getDb();
  // 优化版是独立的一份简历，只断开来源。外键也是 SET NULL，
  // 但显式写一次能落进同步 oplog，手机端拿到的是同一个结果。
  db.update(schema.resumeVariant)
    .set({ sourceResumeId: null })
    .where(eq(schema.resumeVariant.sourceResumeId, id))
    .run();
  db.delete(schema.resume).where(eq(schema.resume.id, id)).run();
}

export function saveJdParsed(campaignId: string, parsed: JdParsed): void {
  getDb()
    .update(schema.campaign)
    .set({ jdParsed: parsed, updatedAt: Date.now() })
    .where(eq(schema.campaign.id, campaignId))
    .run();
}

export function saveResumeParsed(resumeId: string, parsed: ResumeParsed): void {
  getDb()
    .update(schema.resume)
    .set({ parsed })
    .where(eq(schema.resume.id, resumeId))
    .run();
}

export function getCampaignRow(id: string): Campaign {
  const row = getDb().select().from(schema.campaign).where(eq(schema.campaign.id, id)).get();
  if (!row) throw new Error('Campaign 不存在');
  return rowToCampaign(row);
}

export function getResumeRow(id: string): Resume {
  const row = getDb().select().from(schema.resume).where(eq(schema.resume.id, id)).get();
  if (!row) throw new Error('简历不存在');
  return rowToResume(row);
}

export function clearCampaignNodes(campaignId: string): void {
  getDb()
    .delete(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .run();
}

export function insertNodes(nodes: Array<typeof schema.knowledgeNode.$inferInsert>): void {
  const db = getDb();
  for (const node of nodes) {
    // NaN 会被 better-sqlite3 绑定为 NULL，显式写入 NOT NULL 列会炸。
    // LLM 输出不可信，任何调用方传来非有限分数都归一为 0。
    db.insert(schema.knowledgeNode)
      .values({ ...node, priorityScore: Number.isFinite(node.priorityScore) ? node.priorityScore : 0 })
      .run();
  }
}

export function updateNodeCoverage(
  updates: Array<{ id: string; coverageType: KnowledgeNode['coverageType'] }>,
): void {
  const db = getDb();
  for (const u of updates) {
    const row = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, u.id))
      .get();
    if (!row) continue;
    const priority = computePriority({ ...rowToNode(row), coverageType: u.coverageType });
    db.update(schema.knowledgeNode)
      .set({
        coverageType: u.coverageType,
        priorityScore: priority.score,
      })
      .where(eq(schema.knowledgeNode.id, u.id))
      .run();
  }
}

export function refreshAllPriorities(campaignId: string): void {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();
  for (const row of rows) {
    const { score } = computePriority(rowToNode(row));
    db.update(schema.knowledgeNode)
      .set({ priorityScore: score })
      .where(eq(schema.knowledgeNode.id, row.id))
      .run();
  }
}

export { rowToNode };
