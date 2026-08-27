import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { QuizAttempt } from '@shared/entities';
import type { NodeStatus } from '@shared/enums';
import type {
  QuizAnswerResult,
  QuizDraftResult,
  QuizQuestionResult,
  QuizSubmitResult,
  QuizUpdateDraftInput,
} from '@shared/ipc';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { completeJson } from '../llm/json';
import { getDb, schema } from '../db';
import { rowToNode } from '../campaign/repository';
import { buildCampaignCandidateContext } from '../campaign/candidateContext';
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

function rowToDraft(row: typeof schema.knowledgeNode.$inferSelect): QuizDraftResult {
  return {
    nodeId: row.id,
    nodeName: row.name,
    questionMd: row.quizQuestionMd ?? null,
    recommendedAnswerMd: row.quizRecommendedAnswerMd ?? null,
  };
}

export function getQuizDraft(nodeId: string): QuizDraftResult {
  const row = getDb()
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) throw new Error('考点不存在');
  return rowToDraft(row);
}

export function updateQuizDraft(input: QuizUpdateDraftInput): QuizDraftResult {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, input.nodeId))
    .get();
  if (!row) throw new Error('考点不存在');

  const patch: {
    quizQuestionMd?: string | null;
    quizRecommendedAnswerMd?: string | null;
  } = {};
  if (input.questionMd !== undefined) patch.quizQuestionMd = input.questionMd;
  if (input.recommendedAnswerMd !== undefined) {
    patch.quizRecommendedAnswerMd = input.recommendedAnswerMd;
  }
  if (Object.keys(patch).length === 0) return rowToDraft(row);

  db.update(schema.knowledgeNode)
    .set(patch)
    .where(eq(schema.knowledgeNode.id, input.nodeId))
    .run();

  return rowToDraft({ ...row, ...patch });
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

  const result = await completeJson<{ question: string }>(
    'quiz',
    'quiz.question',
    buildCampaignCandidateContext(node.campaignId, node),
  );

  const question = result.question.trim();
  db.update(schema.knowledgeNode)
    .set({ quizQuestionMd: question, quizRecommendedAnswerMd: null })
    .where(eq(schema.knowledgeNode.id, nodeId))
    .run();

  return { nodeId, nodeName: node.name, question };
}

/**
 * 出完题就能要一份参考答案。答不上来的题最需要范本，而评分给的「改进话术」
 * 只会改写用户已经说出口的内容，正好在这种时候派不上用场。
 */
export async function generateQuizAnswer(
  nodeId: string,
  question: string,
): Promise<QuizAnswerResult> {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) throw new Error('考点不存在');

  const node = rowToNode(row);

  const generated = await completeJson<{ answerMd: string }>(
    'quiz',
    'quiz.answer',
    `${buildCampaignCandidateContext(node.campaignId, node, question)}
问题：${question}`,
  );

  const recommendedAnswerMd = normalizeDisplayText(generated.answerMd);
  db.update(schema.knowledgeNode)
    .set({ quizRecommendedAnswerMd: recommendedAnswerMd })
    .where(eq(schema.knowledgeNode.id, nodeId))
    .run();

  return { recommendedAnswerMd };
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

  const scored = await completeJson<QuizScoreResult>(
    'quiz',
    'quiz.score',
    `${buildCampaignCandidateContext(node.campaignId, node, `${question}\n${userAnswer}`)}
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
