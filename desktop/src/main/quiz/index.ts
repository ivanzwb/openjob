import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { QuizAttempt } from '@core/entities';
import type {
  QuizAnswerResult,
  QuizDraftResult,
  QuizQuestionResult,
  QuizSubmitResult,
  QuizUpdateDraftInput,
} from '@core/ipc';
import { normalizeDisplayText } from '@core/lib/markdownDisplay';
import { completeJson } from '../llm/json';
import { getDb, getRawDb, schema } from '../db';
import { rowToNode } from '../campaign/repository';
import { buildCampaignCandidateContext } from '../campaign/candidateContext';
import { writeMasterySignal } from '../practice/mastery';
import { saveSpeechFromQuiz } from '../speech';

interface QuizScoreResult {
  score: number;
  feedbackMd: string;
  improvedScriptMd: string;
}

function rowToDraft(row: typeof schema.knowledgeNode.$inferSelect): QuizDraftResult {
  return {
    nodeId: row.id,
    nodeName: row.name,
    questionMd: row.quizQuestionMd ?? null,
    recommendedAnswerMd: row.quizRecommendedAnswerMd ?? null,
    answerDraftMd: row.quizAnswerDraftMd ?? null,
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
    quizAnswerDraftMd?: string | null;
  } = {};
  if (input.questionMd !== undefined) patch.quizQuestionMd = input.questionMd;
  if (input.recommendedAnswerMd !== undefined) {
    patch.quizRecommendedAnswerMd = input.recommendedAnswerMd;
  }
  if (input.answerDraftMd !== undefined) patch.quizAnswerDraftMd = input.answerDraftMd;
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
  // 换了题，上一题的作答草稿就没有意义了，跟推荐答案一起清掉
  db.update(schema.knowledgeNode)
    .set({ quizQuestionMd: question, quizRecommendedAnswerMd: null, quizAnswerDraftMd: null })
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

  // 混合权重与 status/priority 的重算都在这一处，答题和对话自评走的是同一条路
  const mastery = writeMasterySignal(getRawDb(), nodeId, { kind: 'practice', score });

  db.update(schema.knowledgeNode)
    // 已经评过分，草稿留着下次进来会又冒出来盖住结果
    .set({ quizAnswerDraftMd: null })
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
    masteryUpdated: mastery.mastery,
    nodeStatus: mastery.status,
  };
}
