/**
 * 练习四张表的读写。
 *
 * 只做搬运，不做判断：能不能追问、分数是否站得住，都在 service / shared 里决定。
 * 分开是因为「写错一行」和「判错一次」的排查方式完全不同。
 *
 * 走原始 SQL 而不是 Drizzle，和 plugins/runtime、evidence/repository 一致：这样
 * 用例能对着一份真的跑过迁移的内存库跑完整流程，而不是对着打桩出来的查询链断言。
 */

import type { Database } from 'better-sqlite3';
import type {
  PracticeAttempt,
  PracticeDimensionScore,
  PracticeSession,
  PracticeTurn,
  RubricScore,
} from '@shared/practice';
import type {
  FollowUpStrategy,
  InterviewProtocol,
  PracticeSessionStatus,
  PracticeTurnKind,
  PracticeTurnSpeaker,
} from '@shared/enums';

interface SessionRow {
  id: string;
  campaign_id: string;
  node_id: string | null;
  format_id: string;
  protocol: InterviewProtocol;
  rubric_id: string;
  role_pack_id: string;
  role_pack_version: string;
  config_snapshot_hash: string;
  max_follow_ups: number;
  follow_up_strategy: FollowUpStrategy;
  status: PracticeSessionStatus;
  previous_attempt_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  turn_index: number;
  speaker: PracticeTurnSpeaker;
  kind: PracticeTurnKind;
  content_md: string;
  created_at: number;
}

export interface AttemptRow {
  id: string;
  session_id: string;
  campaign_id: string;
  node_id: string | null;
  format_id: string;
  rubric_id: string;
  competency_ids: string;
  question_md: string;
  answer_md: string;
  transcript_md: string | null;
  total_score: number;
  feedback_md: string;
  improved_script_md: string | null;
  needs_repractice: number;
  previous_attempt_id: string | null;
  prompt_version_id: string;
  created_at: number;
}

interface ScoreRow {
  id: string;
  attempt_id: string;
  rubric_id: string;
  dimension_id: string;
  dimension_label: string;
  weight: number;
  critical: number;
  score: number;
  anchor_md: string;
  answer_quote: string;
  answer_start: number;
  answer_end: number;
  rationale_md: string;
}

const SESSION_COLUMNS = `id, campaign_id, node_id, format_id, protocol, rubric_id,
  role_pack_id, role_pack_version, config_snapshot_hash, max_follow_ups,
  follow_up_strategy, status, previous_attempt_id, created_at, updated_at`;

const ATTEMPT_COLUMNS = `id, session_id, campaign_id, node_id, format_id, rubric_id,
  competency_ids, question_md, answer_md, transcript_md, total_score, feedback_md,
  improved_script_md, needs_repractice, previous_attempt_id, prompt_version_id, created_at`;

function rowToTurn(row: TurnRow): PracticeTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    index: row.turn_index,
    speaker: row.speaker,
    kind: row.kind,
    contentMd: row.content_md,
    createdAt: row.created_at,
  };
}

function parseCompetencyIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToPracticeAttempt(
  row: AttemptRow,
  dimensionScores: Record<string, number>,
): PracticeAttempt {
  return {
    id: row.id,
    source: 'practice',
    readOnly: false,
    campaignId: row.campaign_id,
    nodeId: row.node_id,
    formatId: row.format_id,
    rubricId: row.rubric_id,
    competencyIds: parseCompetencyIds(row.competency_ids),
    questionMd: row.question_md,
    answerMd: row.answer_md,
    transcriptMd: row.transcript_md,
    dimensionScores,
    totalScore: row.total_score,
    feedbackMd: row.feedback_md,
    previousAttemptId: row.previous_attempt_id,
    createdAt: row.created_at,
  };
}

export interface InsertSessionInput {
  id: string;
  campaignId: string;
  nodeId: string | null;
  formatId: string;
  protocol: InterviewProtocol;
  rubricId: string;
  rolePackId: string;
  rolePackVersion: string;
  configSnapshotHash: string;
  maxFollowUps: number;
  followUpStrategy: FollowUpStrategy;
  previousAttemptId: string | null;
  now: number;
}

export function insertSession(raw: Database, input: InsertSessionInput): void {
  raw
    .prepare(
      `INSERT INTO practice_session (
         id, campaign_id, node_id, format_id, protocol, rubric_id,
         role_pack_id, role_pack_version, config_snapshot_hash,
         max_follow_ups, follow_up_strategy, status, previous_attempt_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .run(
      input.id,
      input.campaignId,
      input.nodeId,
      input.formatId,
      input.protocol,
      input.rubricId,
      input.rolePackId,
      input.rolePackVersion,
      input.configSnapshotHash,
      input.maxFollowUps,
      input.followUpStrategy,
      input.previousAttemptId,
      input.now,
      input.now,
    );
}

export function listTurns(raw: Database, sessionId: string): PracticeTurn[] {
  const rows = raw
    .prepare(
      `SELECT id, session_id, turn_index, speaker, kind, content_md, created_at
       FROM practice_turn WHERE session_id = ? ORDER BY turn_index`,
    )
    .all(sessionId) as TurnRow[];
  return rows.map(rowToTurn);
}

export function getSession(raw: Database, sessionId: string): PracticeSession | null {
  const row = raw
    .prepare(`SELECT ${SESSION_COLUMNS} FROM practice_session WHERE id = ?`)
    .get(sessionId) as SessionRow | undefined;
  if (!row) return null;

  return {
    id: row.id,
    campaignId: row.campaign_id,
    nodeId: row.node_id,
    formatId: row.format_id,
    protocol: row.protocol,
    rubricId: row.rubric_id,
    rolePackId: row.role_pack_id,
    rolePackVersion: row.role_pack_version,
    configSnapshotHash: row.config_snapshot_hash,
    maxFollowUps: row.max_follow_ups,
    followUpStrategy: row.follow_up_strategy,
    status: row.status,
    previousAttemptId: row.previous_attempt_id,
    turns: listTurns(raw, sessionId),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AppendTurnInput {
  id: string;
  sessionId: string;
  speaker: PracticeTurnSpeaker;
  kind: PracticeTurnKind;
  contentMd: string;
  now: number;
}

/**
 * 追加一轮，序号由库里已有的轮数决定。
 *
 * 不让调用方传 index：`uq_practice_turn_index` 会把重复序号挡在库里，但那是一次
 * 用户可见的失败；由这里统一取当前最大序号，调用方就没有算错的机会。
 */
export function appendTurn(raw: Database, input: AppendTurnInput): PracticeTurn {
  const last = raw
    .prepare(`SELECT max(turn_index) AS last FROM practice_turn WHERE session_id = ?`)
    .get(input.sessionId) as { last: number | null };
  const index = last.last === null ? 0 : last.last + 1;

  raw
    .prepare(
      `INSERT INTO practice_turn (id, session_id, turn_index, speaker, kind, content_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.sessionId, index, input.speaker, input.kind, input.contentMd, input.now);

  raw
    .prepare(`UPDATE practice_session SET updated_at = ? WHERE id = ?`)
    .run(input.now, input.sessionId);

  return {
    id: input.id,
    sessionId: input.sessionId,
    index,
    speaker: input.speaker,
    kind: input.kind,
    contentMd: input.contentMd,
    createdAt: input.now,
  };
}

export function setSessionStatus(
  raw: Database,
  sessionId: string,
  status: PracticeSessionStatus,
  now: number,
): void {
  raw
    .prepare(`UPDATE practice_session SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, sessionId);
}

export interface InsertAttemptInput {
  id: string;
  sessionId: string;
  campaignId: string;
  nodeId: string | null;
  formatId: string;
  rubricId: string;
  competencyIds: string[];
  questionMd: string;
  answerMd: string;
  transcriptMd: string | null;
  totalScore: number;
  feedbackMd: string;
  improvedScriptMd: string | null;
  needsRepractice: boolean;
  previousAttemptId: string | null;
  promptVersionId: string;
  now: number;
}

export function insertAttempt(raw: Database, input: InsertAttemptInput): void {
  raw
    .prepare(
      `INSERT INTO practice_attempt (
         id, session_id, campaign_id, node_id, format_id, rubric_id, competency_ids,
         question_md, answer_md, transcript_md, total_score, feedback_md,
         improved_script_md, needs_repractice, previous_attempt_id, prompt_version_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.sessionId,
      input.campaignId,
      input.nodeId,
      input.formatId,
      input.rubricId,
      JSON.stringify(input.competencyIds),
      input.questionMd,
      input.answerMd,
      input.transcriptMd,
      input.totalScore,
      input.feedbackMd,
      input.improvedScriptMd,
      input.needsRepractice ? 1 : 0,
      input.previousAttemptId,
      input.promptVersionId,
      input.now,
    );
}

export function insertScores(
  raw: Database,
  attemptId: string,
  scores: readonly PracticeDimensionScore[],
  newId: () => string,
): void {
  const statement = raw.prepare(
    `INSERT INTO practice_score (
       id, attempt_id, rubric_id, dimension_id, dimension_label, weight, critical,
       score, anchor_md, answer_quote, answer_start, answer_end, rationale_md
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const score of scores) {
    statement.run(
      newId(),
      attemptId,
      score.anchor.rubricId,
      score.dimensionId,
      score.label,
      score.weight,
      score.critical ? 1 : 0,
      score.score,
      score.anchor.text,
      score.answer.quote,
      score.answer.start,
      score.answer.end,
      score.rationaleMd,
    );
  }
}

function rowToDimensionScore(row: ScoreRow): PracticeDimensionScore {
  const score = row.score as RubricScore;
  return {
    dimensionId: row.dimension_id,
    label: row.dimension_label,
    weight: row.weight,
    critical: row.critical === 1,
    score,
    anchor: {
      rubricId: row.rubric_id,
      dimensionId: row.dimension_id,
      score,
      text: row.anchor_md,
    },
    answer: { quote: row.answer_quote, start: row.answer_start, end: row.answer_end },
    rationaleMd: row.rationale_md,
  };
}

export function listScores(raw: Database, attemptId: string): PracticeDimensionScore[] {
  const rows = raw
    .prepare(`SELECT * FROM practice_score WHERE attempt_id = ? ORDER BY dimension_id`)
    .all(attemptId) as ScoreRow[];
  return rows.map(rowToDimensionScore);
}

export function listPracticeAttemptRows(
  raw: Database,
  campaignId: string,
  nodeId?: string | null,
): AttemptRow[] {
  if (nodeId === undefined) {
    return raw
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM practice_attempt
         WHERE campaign_id = ? ORDER BY created_at DESC`,
      )
      .all(campaignId) as AttemptRow[];
  }
  if (nodeId === null) {
    return raw
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM practice_attempt
         WHERE campaign_id = ? AND node_id IS NULL ORDER BY created_at DESC`,
      )
      .all(campaignId) as AttemptRow[];
  }
  return raw
    .prepare(
      `SELECT ${ATTEMPT_COLUMNS} FROM practice_attempt
       WHERE campaign_id = ? AND node_id = ? ORDER BY created_at DESC`,
    )
    .all(campaignId, nodeId) as AttemptRow[];
}
