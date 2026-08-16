import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { InterviewReport } from '@shared/entities';
import type { ReportSourceType } from '@shared/enums';
import type { IngestReportResult } from '@shared/ipc';
import { completeJson } from '../llm/json';
import { getDb, schema } from '../db';
import {
  getCampaignRow,
  refreshAllPriorities,
  rowToNode,
} from '../campaign/repository';
import { computePriority } from './priority';
import { boostExamProbByNodeName, CREDIBILITY_WEIGHT } from './prior';
import { type ReportMatchResult } from '@shared/diagnosis/prompts';

function ensureBlindSpotDomain(campaignId: string): string {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.knowledgeNode)
    .where(
      and(
        eq(schema.knowledgeNode.campaignId, campaignId),
        eq(schema.knowledgeNode.name, '真题盲区'),
      ),
    )
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  const now = Date.now();
  const base = {
    id,
    campaignId,
    parentId: null,
    name: '真题盲区',
    kind: 'domain' as const,
    coverageType: 'landmine' as const,
    examProb: 0.9,
    difficulty: 4,
    estMinutes: 20,
    examForms: ['concept' as const],
    mastery: 0,
    masterySource: 'self' as const,
    priorityScore: 0,
    status: 'todo' as const,
    isUserAdded: true,
    createdAt: now,
  };
  const { score } = computePriority(base);
  db.insert(schema.knowledgeNode).values({ ...base, priorityScore: score }).run();
  return id;
}

function createBlindSpotNode(campaignId: string, parentId: string, name: string): string {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const base = {
    id,
    campaignId,
    parentId,
    name: name.trim(),
    kind: 'point' as const,
    coverageType: 'landmine' as const,
    examProb: 0.85,
    difficulty: 4,
    estMinutes: 25,
    examForms: ['concept' as const],
    mastery: 0,
    masterySource: 'self' as const,
    priorityScore: 0,
    status: 'todo' as const,
    isUserAdded: true,
    createdAt: now,
  };
  const { score } = computePriority(base);
  db.insert(schema.knowledgeNode).values({ ...base, priorityScore: score }).run();
  return id;
}

async function matchQuestions(
  questions: string[],
  nodes: Array<{ id: string; name: string }>,
): Promise<ReportMatchResult['matches']> {
  if (questions.length === 0) return [];

  const result = await completeJson<ReportMatchResult>(
    'outline',
    'diagnosis.matchQuestions',
    JSON.stringify({
      questions,
      nodes: nodes.map((n) => n.name),
    }),
  );

  return result.matches ?? [];
}

/**
 * 多源交叉验证：数一数这个考点被几个**独立**来源提到过。
 *
 * 面经质量分布极差，洗稿和层层转载很常见。单一来源提到的考点标为存疑、
 * 只给折扣权重；多个独立来源都提到才给足权重。自己复盘是一手经历，永远算实证。
 */
function corroboration(
  nodeId: string,
  sourceType: ReportSourceType,
): { sources: number; factor: number; verified: boolean } {
  if (sourceType === 'selfDebrief') {
    return { sources: 1, factor: 1, verified: true };
  }

  const db = getDb();
  const questions = db
    .select()
    .from(schema.interviewQuestion)
    .where(eq(schema.interviewQuestion.matchedNodeId, nodeId))
    .all();
  if (questions.length === 0) return { sources: 0, factor: 0.5, verified: false };

  const reports = db
    .select()
    .from(schema.interviewReport)
    .where(
      inArray(
        schema.interviewReport.id,
        [...new Set(questions.map((q) => q.reportId))],
      ),
    )
    .all();

  // 同一篇原文被重复摄入不算多源，按原文前缀去重
  const distinct = new Set(
    reports.map((r) => `${r.sourceType}|${r.rawText.slice(0, 120)}`),
  );
  const sources = distinct.size;

  if (reports.some((r) => r.sourceType === 'selfDebrief')) {
    return { sources, factor: 1, verified: true };
  }
  if (sources >= 2) return { sources, factor: 1, verified: true };
  return { sources, factor: 0.5, verified: false };
}

function boostNode(nodeId: string, credibilityWeight: number, factor: number): void {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) return;

  const boost = 0.08 * credibilityWeight * factor;
  const nextProb = Math.min(1, row.examProb + boost);
  const node = rowToNode({ ...row, examProb: nextProb });
  const { score } = computePriority(node);
  db.update(schema.knowledgeNode)
    .set({ examProb: nextProb, priorityScore: score })
    .where(eq(schema.knowledgeNode.id, nodeId))
    .run();
}

/**
 * 面经摄入管道：拆题 → 匹配节点 → 修正概率 / 标记盲区。
 *
 * sourceId 指向 source 表里的网页记录（含 URL、域名可信度、抓取时间）。
 * 网络来源必须带上，否则用户在 UI 上没法回溯这条真题是从哪抓来的——
 * 与代码结论强制 file:line 是同一条原则。
 */
export async function ingestInterviewReport(
  campaignId: string,
  rawText: string,
  sourceType: ReportSourceType = 'pasted',
  sourceId: string | null = null,
): Promise<IngestReportResult> {
  const campaign = getCampaignRow(campaignId);
  const extracted = await completeJson<{ questions: string[] }>(
    'outline',
    'diagnosis.extractQuestions',
    rawText,
  );

  const db = getDb();
  const reportId = randomUUID();
  const now = Date.now();
  const credibilityWeight = CREDIBILITY_WEIGHT[sourceType];

  db.insert(schema.interviewReport)
    .values({
      id: reportId,
      campaignId,
      company: campaign.company,
      roleTitle: campaign.roleTitle,
      sourceType,
      sourceId,
      rawText,
      reportedAt: now,
      credibilityWeight,
      createdAt: now,
    })
    .run();

  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  const nodeByName = new Map(nodes.map((n) => [n.name, n]));
  const matches = await matchQuestions(
    extracted.questions,
    nodes.map((n) => ({ id: n.id, name: n.name })),
  );

  let nodesUpdated = 0;
  let blindSpotsCreated = 0;
  let crossCampaignUpdated = 0;
  let unverifiedCount = 0;
  let corroboratedCount = 0;

  for (let i = 0; i < extracted.questions.length; i++) {
    const q = extracted.questions[i]!;
    const match = matches.find((m) => m.questionIndex === i);
    let matchedNode = match?.nodeName ? (nodeByName.get(match.nodeName) ?? null) : null;

    if (!matchedNode && match?.suggestedName) {
      const parentId = ensureBlindSpotDomain(campaignId);
      const newId = createBlindSpotNode(campaignId, parentId, match.suggestedName);
      matchedNode =
        db.select().from(schema.knowledgeNode).where(eq(schema.knowledgeNode.id, newId)).get() ??
        null;
      if (matchedNode) {
        nodeByName.set(matchedNode.name, matchedNode);
        blindSpotsCreated++;
      }
    }

    const questionId = randomUUID();
    const isBlindSpot = !matchedNode;

    db.insert(schema.interviewQuestion)
      .values({
        id: questionId,
        reportId,
        questionText: q,
        roundNo: null,
        matchedNodeId: matchedNode?.id ?? null,
        matchConfidence: match?.confidence ?? null,
        isBlindSpot,
        createdAt: now,
      })
      .run();

    if (matchedNode) {
      // 先落库本题再算交叉验证，这样当前这一篇也计入来源计数
      const { factor, verified } = corroboration(matchedNode.id, sourceType);
      if (verified) corroboratedCount++;
      else unverifiedCount++;

      boostNode(matchedNode.id, credibilityWeight, factor);
      nodesUpdated++;
      crossCampaignUpdated += boostExamProbByNodeName(
        matchedNode.name,
        credibilityWeight * factor,
        { excludeCampaignId: campaignId },
      );
    }
  }

  if (sourceType === 'selfDebrief') {
    db.update(schema.campaign)
      .set({ status: 'done', updatedAt: now })
      .where(eq(schema.campaign.id, campaignId))
      .run();
  }

  refreshAllPriorities(campaignId);

  const report: InterviewReport = {
    id: reportId,
    campaignId,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    sourceType,
    sourceId,
    rawText,
    reportedAt: now,
    credibilityWeight,
    createdAt: now,
  };

  return {
    report,
    questionsExtracted: extracted.questions.length,
    nodesUpdated,
    blindSpotsCreated,
    crossCampaignUpdated,
    corroboratedCount,
    unverifiedCount,
  };
}
