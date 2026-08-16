import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { QuizAttempt } from '@shared/entities';
import type { NodeStatus } from '@shared/enums';
import type { QuizQuestionResult, QuizSubmitResult } from '@shared/ipc';
import { completeJson } from '../llm/json';
import { getDb, schema } from '../db';
import { getCampaignRow, rowToNode } from '../campaign/repository';
import { computePriority } from '../diagnosis/priority';
import { saveSpeechFromQuiz } from '../speech';

interface QuizScoreResult {
  score: number;
  feedbackMd: string;
  improvedScriptMd: string;
}

function masteryToStatus(mastery: number): NodeStatus {
  if (mastery >= 4.5) return 'mastered';
  if (mastery >= 2.5) return 'learning';
  return 'shaky';
}

export async function generateQuizQuestion(nodeId: string): Promise<QuizQuestionResult> {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) throw new Error('考点不存在');

  const node = rowToNode(row);
  const campaign = getCampaignRow(node.campaignId);

  const result = await completeJson<{ question: string }>(
    'quiz',
    'quiz.question',
    `公司：${campaign.company} 岗位：${campaign.roleTitle}
考点：${node.name} 覆盖类型：${node.coverageType}`,
  );

  return { nodeId, nodeName: node.name, question: result.question };
}

export async function submitQuizAnswer(
  nodeId: string,
  question: string,
  userAnswer: string,
): Promise<QuizSubmitResult> {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) throw new Error('考点不存在');

  const node = rowToNode(row);
  const campaign = getCampaignRow(node.campaignId);

  const scored = await completeJson<QuizScoreResult>(
    'quiz',
    'quiz.score',
    `公司：${campaign.company} 岗位：${campaign.roleTitle}
考点：${node.name}
问题：${question}
候选人回答：${userAnswer}`,
  );

  const score = Math.min(5, Math.max(1, Math.round(scored.score)));
  // 答题得分权重更高，与自评混合
  const newMastery = node.masterySource === 'quiz'
    ? node.mastery * 0.3 + score * 0.7
    : node.mastery * 0.5 + score * 0.5;

  const nodeStatus = masteryToStatus(newMastery);
  const priority = computePriority({ ...node, mastery: newMastery });

  db.update(schema.knowledgeNode)
    .set({
      mastery: newMastery,
      masterySource: 'quiz',
      status: nodeStatus,
      priorityScore: priority.score,
    })
    .where(eq(schema.knowledgeNode.id, nodeId))
    .run();

  const now = Date.now();
  const attemptId = randomUUID();
  const attempt: QuizAttempt = {
    id: attemptId,
    nodeId,
    question,
    userAnswer,
    score,
    feedbackMd: scored.feedbackMd,
    improvedScriptMd: scored.improvedScriptMd,
    createdAt: now,
  };

  db.insert(schema.quizAttempt)
    .values({
      id: attemptId,
      nodeId,
      question,
      userAnswer,
      score,
      feedbackMd: scored.feedbackMd,
      improvedScriptMd: scored.improvedScriptMd,
      createdAt: now,
    })
    .run();

  if (scored.improvedScriptMd.trim()) {
    saveSpeechFromQuiz(nodeId, attemptId, scored.improvedScriptMd);
  }

  return {
    attempt,
    masteryUpdated: newMastery,
    nodeStatus,
  };
}
