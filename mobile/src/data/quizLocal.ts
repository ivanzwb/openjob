import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QuizAttempt } from '@shared/entities';
import type { NodeStatus } from '@shared/enums';
import type { QuizQuestionResult, QuizSubmitResult } from '@shared/ipc';
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

  return { nodeId, nodeName: node.name, question: result.question };
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
