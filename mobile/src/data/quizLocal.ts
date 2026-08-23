import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
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
import { getMobileConfig } from '../config/settings';
import { completeJson } from '../llm/json';
import { computePriority } from '@shared/priority';
import { getCampaign, getKnowledgeNode } from './campaignLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

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

function rowToDraft(
  row: {
    id: string;
    name: string;
    quiz_question_md: string | null;
    quiz_recommended_answer_md: string | null;
  },
): QuizDraftResult {
  return {
    nodeId: row.id,
    nodeName: row.name,
    questionMd: row.quiz_question_md ?? null,
    recommendedAnswerMd: row.quiz_recommended_answer_md ?? null,
  };
}

export function getQuizDraft(db: SQLiteDatabase, nodeId: string): QuizDraftResult {
  const row = db.getFirstSync<{
    id: string;
    name: string;
    quiz_question_md: string | null;
    quiz_recommended_answer_md: string | null;
  }>(
    `SELECT id, name, quiz_question_md, quiz_recommended_answer_md FROM knowledge_node WHERE id = ?`,
    nodeId,
  );
  if (!row) throw new Error('考点不存在');
  return rowToDraft(row);
}

export async function updateQuizDraft(
  db: SQLiteDatabase,
  input: QuizUpdateDraftInput,
): Promise<QuizDraftResult> {
  const row = db.getFirstSync<{
    id: string;
    name: string;
    quiz_question_md: string | null;
    quiz_recommended_answer_md: string | null;
  }>(
    `SELECT id, name, quiz_question_md, quiz_recommended_answer_md FROM knowledge_node WHERE id = ?`,
    input.nodeId,
  );
  if (!row) throw new Error('考点不存在');

  const identity = await getDeviceIdentity(db);
  const questionMd = input.questionMd !== undefined ? input.questionMd : row.quiz_question_md;
  const recommendedAnswerMd =
    input.recommendedAnswerMd !== undefined
      ? input.recommendedAnswerMd
      : row.quiz_recommended_answer_md;

  if (
    input.questionMd === undefined &&
    input.recommendedAnswerMd === undefined
  ) {
    return rowToDraft(row);
  }

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE knowledge_node SET quiz_question_md = ?, quiz_recommended_answer_md = ? WHERE id = ?`,
      questionMd,
      recommendedAnswerMd,
      input.nodeId,
    );
  });

  return {
    nodeId: row.id,
    nodeName: row.name,
    questionMd,
    recommendedAnswerMd,
  };
}

export async function generateQuizQuestion(
  db: SQLiteDatabase,
  nodeId: string,
): Promise<QuizQuestionResult> {
  const node = getKnowledgeNode(db, nodeId);
  const campaign = getCampaign(db, node.campaignId);

  const result = await completeJson<{ question: string }>(
    'quiz',
    'quiz.question',
    `公司：${campaign.company} 岗位：${campaign.roleTitle}
考点：${node.name} 覆盖类型：${node.coverageType}`,
  );

  const question = result.question.trim();
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE knowledge_node SET quiz_question_md = ?, quiz_recommended_answer_md = NULL WHERE id = ?`,
      question,
      nodeId,
    );
  });

  return { nodeId, nodeName: node.name, question };
}

/**
 * 出完题就能要一份参考答案。答不上来的题最需要范本，而评分给的「改进话术」
 * 只会改写用户已经说出口的内容，正好在这种时候派不上用场。
 */
export async function generateQuizAnswer(
  db: SQLiteDatabase,
  nodeId: string,
  question: string,
): Promise<QuizAnswerResult> {
  const node = getKnowledgeNode(db, nodeId);
  const campaign = getCampaign(db, node.campaignId);

  const generated = await completeJson<{ answerMd: string }>(
    'quiz',
    'quiz.answer',
    `公司：${campaign.company} 岗位：${campaign.roleTitle}
考点：${node.name} 覆盖类型：${node.coverageType}
问题：${question}`,
  );

  const recommendedAnswerMd = normalizeDisplayText(generated.answerMd);
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE knowledge_node SET quiz_recommended_answer_md = ? WHERE id = ?`,
      recommendedAnswerMd,
      nodeId,
    );
  });

  return { recommendedAnswerMd };
}

export async function submitQuizAnswer(
  db: SQLiteDatabase,
  nodeId: string,
  question: string,
  userAnswer: string,
): Promise<QuizSubmitResult> {
  const node = getKnowledgeNode(db, nodeId);
  const campaign = getCampaign(db, node.campaignId);

  const scored = await completeJson<QuizScoreResult>(
    'quiz',
    'quiz.score',
    `公司：${campaign.company} 岗位：${campaign.roleTitle}
考点：${node.name}
问题：${question}
候选人回答：${userAnswer}`,
  );

  const score = Math.min(5, Math.max(1, Math.round(scored.score)));
  const newMastery =
    node.masterySource === 'quiz'
      ? node.mastery * 0.3 + score * 0.7
      : node.mastery * 0.5 + score * 0.5;

  const nodeStatus = masteryToStatus(newMastery);
  const priority = computePriority({ ...node, mastery: newMastery }, getMobileConfig().priority);
  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  const attemptId = Crypto.randomUUID();

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE knowledge_node SET mastery = ?, mastery_source = 'quiz', status = ?, priority_score = ? WHERE id = ?`,
      newMastery,
      nodeStatus,
      priority.score,
      nodeId,
    );
    db.runSync(
      `INSERT INTO quiz_attempt (id, node_id, question, user_answer, score, feedback_md, improved_script_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      attemptId,
      nodeId,
      question,
      userAnswer,
      score,
      scored.feedbackMd,
      scored.improvedScriptMd,
      now,
    );
    if (scored.improvedScriptMd.trim()) {
      db.runSync(
        `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, is_user_edited, created_at)
         VALUES (?, 'quiz', ?, 'spoken', ?, 0, ?)`,
        Crypto.randomUUID(),
        attemptId,
        scored.improvedScriptMd,
        now,
      );
    }
  });

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

  return {
    attempt,
    masteryUpdated: newMastery,
    nodeStatus,
  };
}
