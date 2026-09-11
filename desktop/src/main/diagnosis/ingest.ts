import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { InterviewReport } from '@core/entities';
import type { ReportSourceType } from '@core/enums';
import type { IngestReportResult } from '@core/ipc';
import { completeJson } from '../llm/json';
import { getDb, schema } from '../db';
import {
  getCampaignRow,
  refreshAllPriorities,
  rowToNode,
} from '../campaign/repository';
import { computePriority } from './priority';
import { boostExamProbByNodeName } from './prior';
import { type ReportMatchResult } from '@core/diagnosis/prompts';
import {
  BLIND_SPOT_DOMAIN_DEFAULTS,
  BLIND_SPOT_DOMAIN_NAME,
  BLIND_SPOT_POINT_DEFAULTS,
  CREDIBILITY_WEIGHT,
  boostedExamProb,
  corroborate,
  decideQuestionOutcome,
} from '@core/diagnosis/reportIngest';

function ensureBlindSpotDomain(campaignId: string): string {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.knowledgeNode)
    .where(
      and(
        eq(schema.knowledgeNode.campaignId, campaignId),
        eq(schema.knowledgeNode.name, BLIND_SPOT_DOMAIN_NAME),
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
    name: BLIND_SPOT_DOMAIN_NAME,
    ...BLIND_SPOT_DOMAIN_DEFAULTS,
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
    ...BLIND_SPOT_POINT_DEFAULTS,
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
 * 取出提到过这个考点的所有面经，交给共享层做多源交叉验证。
 *
 * 判定规则（判重口径、折扣系数、复盘永远算实证）在 @core/diagnosis/reportIngest，
 * 手机端录复盘走的是同一份，这里只负责取数。
 */
function corroborationFor(nodeId: string) {
  const db = getDb();
  const questions = db
    .select()
    .from(schema.interviewQuestion)
    .where(eq(schema.interviewQuestion.matchedNodeId, nodeId))
    .all();
  if (questions.length === 0) return corroborate([]);

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

  return corroborate(reports.map((r) => ({ sourceType: r.sourceType, rawText: r.rawText })));
}

function boostNode(nodeId: string, credibilityWeight: number, factor: number): void {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) return;

  const nextProb = boostedExamProb(row.examProb, credibilityWeight, factor);
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
    const outcome = decideQuestionOutcome(
      matches.find((m) => m.questionIndex === i),
      nodeByName,
    );
    let matchedNode = outcome.kind === 'matched' ? (nodeByName.get(outcome.nodeName) ?? null) : null;

    if (outcome.kind === 'newBlindSpot') {
      const parentId = ensureBlindSpotDomain(campaignId);
      const newId = createBlindSpotNode(campaignId, parentId, outcome.suggestedName);
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
        matchConfidence: outcome.confidence,
        isBlindSpot,
        createdAt: now,
      })
      .run();

    if (matchedNode) {
      // 先落库本题再算交叉验证，这样当前这一篇也计入来源计数
      const { factor, verified } = corroborationFor(matchedNode.id);
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
