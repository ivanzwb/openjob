import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
import { REPORT_EXTRACT_SYSTEM, type ReportMatchResult } from './prompts';

const MATCH_SYSTEM = `你是面试真题匹配助手。将每道面试题匹配到最相关的知识点节点。
- 有合适节点时填 nodeName（必须与节点列表完全一致）
- 匹配不上时 nodeName 为 null，并给出 suggestedName 作为新考点名
- confidence 0-1

输出 JSON：
{
  "matches": [
    { "questionIndex": 0, "nodeName": "Redis 持久化", "confidence": 0.85, "suggestedName": null }
  ]
}`;

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
    MATCH_SYSTEM,
    JSON.stringify({
      questions,
      nodes: nodes.map((n) => n.name),
    }),
  );

  return result.matches ?? [];
}

function boostNode(nodeId: string, credibilityWeight: number): void {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) return;

  const boost = 0.08 * credibilityWeight;
  const nextProb = Math.min(1, row.examProb + boost);
  const node = rowToNode({ ...row, examProb: nextProb });
  const { score } = computePriority(node);
  db.update(schema.knowledgeNode)
    .set({ examProb: nextProb, priorityScore: score })
    .where(eq(schema.knowledgeNode.id, nodeId))
    .run();
}

/** 面经摄入管道：拆题 → 匹配节点 → 修正概率 / 标记盲区 */
export async function ingestInterviewReport(
  campaignId: string,
  rawText: string,
  sourceType: ReportSourceType = 'pasted',
): Promise<IngestReportResult> {
  const campaign = getCampaignRow(campaignId);
  const extracted = await completeJson<{ questions: string[] }>(
    'outline',
    REPORT_EXTRACT_SYSTEM,
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
      sourceId: null,
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
      boostNode(matchedNode.id, credibilityWeight);
      nodesUpdated++;
      crossCampaignUpdated += boostExamProbByNodeName(matchedNode.name, credibilityWeight, {
        excludeCampaignId: campaignId,
      });
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
    sourceId: null,
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
  };
}
