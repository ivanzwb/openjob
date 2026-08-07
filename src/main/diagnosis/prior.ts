import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { rowToNode } from '../campaign/repository';
import { computePriority } from './priority';

/** 各面经来源的可信度权重，影响考察概率修正幅度 */
export const CREDIBILITY_WEIGHT: Record<
  (typeof schema.interviewReport.$inferSelect)['sourceType'],
  number
> = {
  selfDebrief: 1,
  pasted: 0.8,
  web: 0.5,
};

const BASE_PROB_BOOST = 0.08;

/**
 * 按节点名跨 Campaign 提升考察概率。
 * 第二个 Campaign 的排序会受益于第一家公司的真题回流。
 */
export function boostExamProbByNodeName(
  nodeName: string,
  credibilityWeight: number,
  opts?: { excludeCampaignId?: string; onlyCompany?: string },
): number {
  const db = getDb();
  const boost = BASE_PROB_BOOST * credibilityWeight;
  const normalized = nodeName.trim().toLowerCase();
  if (!normalized) return 0;

  let rows = db.select().from(schema.knowledgeNode).all();
  if (opts?.excludeCampaignId) {
    rows = rows.filter((r) => r.campaignId !== opts.excludeCampaignId);
  }
  if (opts?.onlyCompany) {
    const campaignIds = new Set(
      db
        .select({ id: schema.campaign.id })
        .from(schema.campaign)
        .where(eq(schema.campaign.company, opts.onlyCompany))
        .all()
        .map((c) => c.id),
    );
    rows = rows.filter((r) => campaignIds.has(r.campaignId));
  }

  let updated = 0;
  for (const row of rows) {
    if (row.name.trim().toLowerCase() !== normalized) continue;
    const nextProb = Math.min(1, row.examProb + boost);
    const node = rowToNode({ ...row, examProb: nextProb });
    const { score } = computePriority(node);
    db.update(schema.knowledgeNode)
      .set({ examProb: nextProb, priorityScore: score })
      .where(eq(schema.knowledgeNode.id, row.id))
      .run();
    updated++;
  }
  return updated;
}

/** 新 Campaign 诊断后，用历史真题先验修正同公司节点的考察概率 */
export function applyHistoricalPrior(campaignId: string, company: string): number {
  const db = getDb();
  const reports = db
    .select()
    .from(schema.interviewReport)
    .where(eq(schema.interviewReport.company, company))
    .all()
    .filter((r) => r.campaignId !== campaignId);

  if (reports.length === 0) return 0;

  const reportIds = new Set(reports.map((r) => r.id));
  const questions = db.select().from(schema.interviewQuestion).all().filter((q) => {
    if (!reportIds.has(q.reportId) || !q.matchedNodeId) return false;
    return true;
  });

  const reportWeight = new Map(reports.map((r) => [r.id, r.credibilityWeight]));
  const nodeNames = new Map<string, number>();

  for (const q of questions) {
    const node = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, q.matchedNodeId!))
      .get();
    if (!node) continue;
    const w = reportWeight.get(q.reportId) ?? 0.8;
    nodeNames.set(node.name, Math.max(nodeNames.get(node.name) ?? 0, w));
  }

  let boosted = 0;
  const campaignNodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  for (const row of campaignNodes) {
    const weight = nodeNames.get(row.name);
    if (!weight) continue;
    const boost = BASE_PROB_BOOST * weight;
    const nextProb = Math.min(1, row.examProb + boost);
    if (nextProb === row.examProb) continue;
    const node = rowToNode({ ...row, examProb: nextProb });
    const { score } = computePriority(node);
    db.update(schema.knowledgeNode)
      .set({ examProb: nextProb, priorityScore: score })
      .where(eq(schema.knowledgeNode.id, row.id))
      .run();
    boosted++;
  }

  return boosted;
}

export function countCrossCampaignReports(company: string): number {
  const result = getDb()
    .select({ n: sql<number>`count(distinct ${schema.interviewReport.campaignId})` })
    .from(schema.interviewReport)
    .where(eq(schema.interviewReport.company, company))
    .get();
  return result?.n ?? 0;
}
