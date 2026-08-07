import { randomUUID } from 'node:crypto';
import { eq, desc, sql, and } from 'drizzle-orm';
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
  BlindSpotQuestion,
} from '@shared/ipc';
import { getDb, schema } from '../db';
import { attachPriorityReason, computePriority } from '../diagnosis/priority';
import { countCrossCampaignReports } from '../diagnosis/prior';

function rowToCampaign(row: typeof schema.campaign.$inferSelect): Campaign {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.roleTitle,
    jdRaw: row.jdRaw,
    jdParsed: row.jdParsed ?? null,
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
    createdAt: row.createdAt,
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

  const nodeRows = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, id))
    .orderBy(desc(schema.knowledgeNode.priorityScore))
    .all();

  const nodes: KnowledgeNodeView[] = nodeRows.map((n) =>
    attachPriorityReason(rowToNode(n)),
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
  const row = {
    id,
    company: input.company.trim(),
    roleTitle: input.roleTitle.trim(),
    jdRaw: input.jdRaw.trim(),
    jdParsed: null,
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
  const row = {
    id: randomUUID(),
    label: label.trim(),
    rawText: rawText.trim(),
    parsed: null,
    createdAt: Date.now(),
  };
  db.insert(schema.resume).values(row).run();
  return rowToResume(row);
}

export function deleteResume(id: string): void {
  getDb().delete(schema.resume).where(eq(schema.resume.id, id)).run();
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
    db.insert(schema.knowledgeNode).values(node).run();
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
