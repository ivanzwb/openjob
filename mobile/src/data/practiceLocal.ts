/**
 * 手机端的练习引擎：出题 → 追问 → 评分。
 *
 * 与桌面 `src/main/practice/service.ts` 是同一套协议、同一份 core 契约：题型与量规来自
 * 同步过来的岗位包（`role_pack_cache`），Prompt 由组合器用包的片段 + 题型协议 + 量规锚点
 * 拼出，逐维分数的锚点与原文引用由 core 校验（`groundDimensionScores`）。这里只做三件事：
 * 把包声明解析成一次会话、调手机端自己的 LLM、把结果按协议写进 `practice_*` 表。
 *
 * 这些表参与同步，所以手机端做完的一次练习会在下次同步回到桌面，掌握度与历史两端一致；
 * 写入一律走 `writingAs` 标成本机来源，不产生回声。
 */
import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  CoverageType,
  InterviewProtocol,
  FollowUpStrategy,
  MasterySource,
  PracticeSessionStatus,
  NodeStatus,
} from '@core/enums';
import { formatIdForExamForm } from '@core/plugins/examForms';
import type { CampaignRuntimeDescriptor, RolePack } from '@core/plugins/types';
import {
  PracticeError,
  groundDimensionScores,
  needsRePractice as needsRePracticeFor,
  practiceQuestionRequest,
  practiceScoreRepairRequest,
  practiceScoreRequest,
  readGeneratedEvaluation,
  readGeneratedQuestion,
  resolvePracticeFormat,
  weightedTotalScore,
  type PracticeDimensionScore,
  type PracticeEvaluation,
  type PracticeEvaluationInput,
  type PracticeSession,
  type PracticeSessionInput,
  type PracticeTurn,
  type PracticeTurnInput,
} from '@core/practice';
import { composePrompt } from '@core/prompts/composer';
import { buildCandidateContext } from '@core/prompts/candidateContext';
import { applyMasterySignal, masteryToStatus } from '@core/practice';
import { computePriority } from '@core/priority';
import { getMobileConfig } from '../config/settings';
import { completeJsonWithSystem } from '../llm/json';
import { loadCandidateContextInput } from './candidateContextLocal';
import { getCachedRolePack } from './rolePackLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

/** 练习沿用 quiz 这一档模型配置：出题与评分与「考我」是同一类任务。 */
const PRACTICE_ROLE = 'quiz';

/** 追问到上限后由引擎直接收束，不再问模型：这句话没有任何需要生成的内容。 */
const CLOSING_MD = '本轮追问已到上限，请整理最终作答后提交评分。';

// ---------------------------------------------------------------------------
// 岗位包解析
// ---------------------------------------------------------------------------

export interface MobilePracticeRuntime {
  descriptor: CampaignRuntimeDescriptor;
  rolePack: RolePack;
  interviewLanguage: string;
}

interface DescriptorRow {
  core_version: string;
  role_pack: string;
  industry_variant_id: string | null;
  capabilities: string;
  competency_baseline_version: string;
  config_snapshot_hash: string;
  resolved_at: number;
}

/**
 * 取本机缓存里的岗位包：pin 的精确版本优先（复核旧评分要当时的量规），
 * 没有就退到同 id 的最新缓存——与桌面的 findLatestRolePack 同义。
 */
function cachedPack(db: SQLiteDatabase, id: string, version: string): RolePack | null {
  const exact = getCachedRolePack(db, id, version);
  if (exact) return exact;
  const row = db.getFirstSync<{ pack_json: string }>(
    `SELECT pack_json FROM role_pack_cache WHERE id = ? ORDER BY fetched_at DESC LIMIT 1`,
    id,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.pack_json) as RolePack;
  } catch {
    // 缓存行损坏等价于没缓存：下一轮同步会重新取一份
    return null;
  }
}

/**
 * 取这场战役当时那一套岗位包。
 *
 * 与桌面同理：pin 的精确版本优先（复核旧评分要当时的量规），本机没有就退到同 id 的缓存版本；
 * 一个都没有才报 role-pack-unavailable——手机上「还没同步到包」是常态，界面要显示得出来。
 */
export function resolveCampaignPracticeRuntime(
  db: SQLiteDatabase,
  campaignId: string,
): MobilePracticeRuntime {
  const row = db.getFirstSync<DescriptorRow>(
    `SELECT core_version, role_pack, industry_variant_id, capabilities,
            competency_baseline_version, config_snapshot_hash, resolved_at
     FROM campaign_runtime_descriptor WHERE campaign_id = ? ORDER BY revision DESC LIMIT 1`,
    campaignId,
  );
  if (!row) {
    throw new PracticeError('campaign-not-found', `这场备考还没有运行配置，先同步一次`);
  }

  const ref = JSON.parse(row.role_pack) as { id: string; version: string };
  const rolePack = cachedPack(db, ref.id, ref.version);
  if (!rolePack) {
    throw new PracticeError(
      'role-pack-unavailable',
      `本机还没有取到岗位包 ${ref.id}，先与桌面端同步一次`,
    );
  }

  const language = db.getFirstSync<{ interview_language: string }>(
    `SELECT p.interview_language FROM role_profile p
     JOIN campaign c ON c.role_profile_id = p.id WHERE c.id = ?`,
    campaignId,
  );

  return {
    descriptor: {
      campaignId,
      coreVersion: row.core_version,
      rolePack: ref,
      industryVariantId: row.industry_variant_id ?? undefined,
      capabilities: JSON.parse(row.capabilities) as CampaignRuntimeDescriptor['capabilities'],
      competencyBaselineVersion: row.competency_baseline_version,
      configSnapshotHash: row.config_snapshot_hash,
      resolvedAt: row.resolved_at,
    },
    rolePack,
    interviewLanguage: language?.interview_language ?? 'zh',
  };
}

export interface PracticeFormatOption {
  id: string;
  label: string;
}

/** 这场战役能练的题型：全部来自岗位包的 `interviewFormats` 声明。 */
export function practiceFormatOptions(db: SQLiteDatabase, campaignId: string): PracticeFormatOption[] {
  const { rolePack } = resolveCampaignPracticeRuntime(db, campaignId);
  return rolePack.interviewFormats.map((format) => ({ id: format.id, label: format.label }));
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  campaign_id: string;
  node_id: string | null;
  format_id: string;
  protocol: string;
  rubric_id: string;
  role_pack_id: string;
  role_pack_version: string;
  config_snapshot_hash: string;
  max_follow_ups: number;
  follow_up_strategy: string;
  status: string;
  previous_attempt_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  turn_index: number;
  speaker: string;
  kind: string;
  content_md: string;
  created_at: number;
}

function listTurns(db: SQLiteDatabase, sessionId: string): PracticeTurn[] {
  return db
    .getAllSync<TurnRow>(
      `SELECT id, session_id, turn_index, speaker, kind, content_md, created_at
       FROM practice_turn WHERE session_id = ? ORDER BY turn_index ASC`,
      sessionId,
    )
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      index: row.turn_index,
      speaker: row.speaker as PracticeTurn['speaker'],
      kind: row.kind as PracticeTurn['kind'],
      contentMd: row.content_md,
      createdAt: row.created_at,
    }));
}

function rowToSession(db: SQLiteDatabase, row: SessionRow): PracticeSession {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    nodeId: row.node_id,
    formatId: row.format_id,
    protocol: row.protocol as InterviewProtocol,
    rubricId: row.rubric_id,
    rolePackId: row.role_pack_id,
    rolePackVersion: row.role_pack_version,
    configSnapshotHash: row.config_snapshot_hash,
    maxFollowUps: row.max_follow_ups,
    followUpStrategy: row.follow_up_strategy as FollowUpStrategy,
    status: row.status as PracticeSessionStatus,
    previousAttemptId: row.previous_attempt_id,
    turns: listTurns(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPracticeSession(db: SQLiteDatabase, sessionId: string): PracticeSession | null {
  const row = db.getFirstSync<SessionRow>(`SELECT * FROM practice_session WHERE id = ?`, sessionId);
  return row ? rowToSession(db, row) : null;
}

/** 这场战役最近的练习会话，新的在前。 */
export function listPracticeSessions(
  db: SQLiteDatabase,
  campaignId: string,
  limit = 20,
): PracticeSession[] {
  return db
    .getAllSync<SessionRow>(
      `SELECT * FROM practice_session WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?`,
      campaignId,
      limit,
    )
    .map((row) => rowToSession(db, row));
}

// ---------------------------------------------------------------------------
// 协议实现
// ---------------------------------------------------------------------------

function loadSessionOrThrow(db: SQLiteDatabase, sessionId: string): PracticeSession {
  const session = getPracticeSession(db, sessionId);
  if (!session) throw new PracticeError('session-not-found', `练习会话 ${sessionId} 不存在`);
  return session;
}

function nextTurnIndex(db: SQLiteDatabase, sessionId: string): number {
  const row = db.getFirstSync<{ next: number }>(
    `SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM practice_turn WHERE session_id = ?`,
    sessionId,
  );
  return row?.next ?? 0;
}

function appendTurn(
  db: SQLiteDatabase,
  input: {
    sessionId: string;
    speaker: PracticeTurn['speaker'];
    kind: PracticeTurn['kind'];
    contentMd: string;
    now: number;
    deviceId: string;
  },
): PracticeTurn {
  const id = Crypto.randomUUID();
  const index = nextTurnIndex(db, input.sessionId);
  writingAs(db, input.deviceId, () => {
    db.runSync(
      `INSERT INTO practice_turn (id, session_id, turn_index, speaker, kind, content_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId,
      index,
      input.speaker,
      input.kind,
      input.contentMd,
      input.now,
    );
    db.runSync(`UPDATE practice_session SET updated_at = ? WHERE id = ?`, input.now, input.sessionId);
  });
  return {
    id,
    sessionId: input.sessionId,
    index,
    speaker: input.speaker,
    kind: input.kind,
    contentMd: input.contentMd,
    createdAt: input.now,
  };
}

/**
 * 出题与评分的 user message 里带的候选人上下文。
 *
 * 与手机端「考我」同一份装配（`buildCandidateContext`）：练习本身不产出个人事实，
 * 组合器那边也不需要证据层，但模型要举例时必须看到 JD 与简历，否则只能照着 JD 编。
 */
function candidateContextText(db: SQLiteDatabase, campaignId: string): string {
  try {
    return buildCandidateContext(loadCandidateContextInput(db, campaignId));
  } catch {
    // 简历没同步过来不该拦住练习
    return '';
  }
}

export async function startPracticeSession(
  db: SQLiteDatabase,
  input: PracticeSessionInput,
): Promise<PracticeSession> {
  const runtime = resolveCampaignPracticeRuntime(db, input.campaignId);
  const formatId =
    input.formatId ??
    (input.examForm ? formatIdForExamForm(runtime.rolePack, input.examForm) : undefined);
  if (!formatId) {
    throw new PracticeError('unknown-format', 'createSession 必须给出 formatId 或 examForm');
  }

  const { format, rubric } = resolvePracticeFormat(runtime.rolePack, formatId);
  const prompt = composePrompt({
    runtime: runtime.descriptor,
    rolePack: runtime.rolePack,
    slot: 'questionGeneration',
    formatId,
    evidence: [],
    userRequest: practiceQuestionRequest({ format, userRequest: input.userRequest }),
  });
  const context = candidateContextText(db, input.campaignId);

  const generated = readGeneratedQuestion(
    await completeJsonWithSystem<unknown>(
      PRACTICE_ROLE,
      prompt.systemPrompt,
      [practiceQuestionRequest({ format, userRequest: input.userRequest }), context]
        .filter(Boolean)
        .join('\n\n'),
    ),
  );

  const sessionId = Crypto.randomUUID();
  const timestamp = Date.now();
  const identity = await getDeviceIdentity(db);

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO practice_session (
         id, campaign_id, node_id, format_id, protocol, rubric_id, role_pack_id,
         role_pack_version, config_snapshot_hash, max_follow_ups, follow_up_strategy,
         status, previous_attempt_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      sessionId,
      input.campaignId,
      input.nodeId ?? null,
      formatId,
      format.protocol,
      rubric.id,
      runtime.rolePack.manifest.id,
      runtime.rolePack.manifest.version,
      runtime.descriptor.configSnapshotHash,
      format.followUpPolicy.maxRounds,
      format.followUpPolicy.strategy,
      input.previousAttemptId ?? null,
      timestamp,
      timestamp,
    );
  });

  appendTurn(db, {
    sessionId,
    speaker: 'interviewer',
    kind: 'question',
    contentMd: generated.questionMd,
    now: timestamp,
    deviceId: identity.deviceId,
  });

  return loadSessionOrThrow(db, sessionId);
}

/**
 * 落一轮作答，再决定追问还是收束。
 *
 * 先把作答写进库再去问模型：模型这一步失败时，用户刚打完的那段回答不该跟着丢。
 */
export async function answerPracticeTurn(
  db: SQLiteDatabase,
  input: PracticeTurnInput,
): Promise<PracticeTurn> {
  const session = loadSessionOrThrow(db, input.sessionId);
  if (session.status !== 'open') {
    throw new PracticeError('session-closed', `会话 ${session.id} 已结束，不能继续作答`);
  }
  if (!input.answerMd.trim()) {
    throw new PracticeError('empty-answer', '作答不能为空');
  }

  const identity = await getDeviceIdentity(db);
  appendTurn(db, {
    sessionId: session.id,
    speaker: 'candidate',
    kind: 'answer',
    contentMd: input.answerMd,
    now: Date.now(),
    deviceId: identity.deviceId,
  });

  const asked = session.turns.filter((turn) => turn.kind === 'followUp').length;
  if (asked >= session.maxFollowUps) {
    return appendTurn(db, {
      sessionId: session.id,
      speaker: 'interviewer',
      kind: 'closing',
      contentMd: CLOSING_MD,
      now: Date.now(),
      deviceId: identity.deviceId,
    });
  }

  const runtime = resolveCampaignPracticeRuntime(db, session.campaignId);
  const { format } = resolvePracticeFormat(runtime.rolePack, session.formatId);
  const request = practiceQuestionRequest({ format, followUpRound: asked + 1 });
  const prompt = composePrompt({
    runtime: runtime.descriptor,
    rolePack: runtime.rolePack,
    slot: 'questionGeneration',
    formatId: session.formatId,
    evidence: [],
    userRequest: request,
  });
  const generated = readGeneratedQuestion(
    await completeJsonWithSystem<unknown>(
      PRACTICE_ROLE,
      prompt.systemPrompt,
      `${request}\n\n候选人上一轮作答：\n${input.answerMd}`,
    ),
  );

  return appendTurn(db, {
    sessionId: session.id,
    speaker: 'interviewer',
    kind: 'followUp',
    contentMd: generated.questionMd,
    now: Date.now(),
    deviceId: identity.deviceId,
  });
}

interface AttemptRow {
  id: string;
  session_id: string;
  campaign_id: string;
  node_id: string | null;
  format_id: string;
  rubric_id: string;
  total_score: number;
  feedback_md: string;
  improved_script_md: string | null;
  needs_repractice: number;
  created_at: number;
}

interface ScoreRow {
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
  rubric_id: string;
}

/** 逐维分数：锚点原文与原文区间都从库里读回来，结果页才能复核每一个分数。 */
export function practiceAttemptScores(db: SQLiteDatabase, attemptId: string): PracticeDimensionScore[] {
  return db
    .getAllSync<ScoreRow>(
      `SELECT dimension_id, dimension_label, weight, critical, score, anchor_md,
              answer_quote, answer_start, answer_end, rationale_md, rubric_id
       FROM practice_score WHERE attempt_id = ? ORDER BY dimension_id ASC`,
      attemptId,
    )
    .map((row) => ({
      dimensionId: row.dimension_id,
      label: row.dimension_label,
      weight: row.weight,
      critical: row.critical === 1,
      score: row.score as PracticeDimensionScore['score'],
      anchor: {
        rubricId: row.rubric_id,
        dimensionId: row.dimension_id,
        score: row.score as PracticeDimensionScore['score'],
        text: row.anchor_md,
      },
      answer: { quote: row.answer_quote, start: row.answer_start, end: row.answer_end },
      rationaleMd: row.rationale_md,
    }));
}

export interface PracticeHistoryItem {
  id: string;
  sessionId: string;
  formatId: string;
  rubricId: string;
  questionMd: string;
  totalScore: number;
  feedbackMd: string;
  improvedScriptMd: string | null;
  needsRePractice: boolean;
  createdAt: number;
}

export function listPracticeHistory(
  db: SQLiteDatabase,
  campaignId: string,
  limit = 20,
): PracticeHistoryItem[] {
  return db
    .getAllSync<AttemptRow>(
      `SELECT id, session_id, campaign_id, node_id, format_id, rubric_id, total_score,
              feedback_md, improved_script_md, needs_repractice, created_at
       FROM practice_attempt WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?`,
      campaignId,
      limit,
    )
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      formatId: row.format_id,
      rubricId: row.rubric_id,
      questionMd: db.getFirstSync<{ question_md: string }>(
        `SELECT question_md FROM practice_attempt WHERE id = ?`,
        row.id,
      )?.question_md ?? '',
      totalScore: row.total_score,
      feedbackMd: row.feedback_md,
      improvedScriptMd: row.improved_script_md,
      needsRePractice: row.needs_repractice === 1,
      createdAt: row.created_at,
    }));
}

export async function evaluatePractice(
  db: SQLiteDatabase,
  input: PracticeEvaluationInput,
): Promise<PracticeEvaluation> {
  const session = loadSessionOrThrow(db, input.sessionId);
  const answerMd =
    input.answerMd ??
    [...session.turns].reverse().find((turn) => turn.speaker === 'candidate')?.contentMd ??
    '';
  if (!answerMd.trim()) {
    throw new PracticeError('empty-answer', '没有可评分的作答');
  }

  const runtime = resolveCampaignPracticeRuntime(db, session.campaignId);
  const { rubric } = resolvePracticeFormat(runtime.rolePack, session.formatId);
  const questionMd = session.turns.find((turn) => turn.kind === 'question')?.contentMd ?? '';
  const transcriptMd = session.turns
    .map((turn) => `**${turn.speaker === 'interviewer' ? '面试官' : '候选人'}**：${turn.contentMd}`)
    .join('\n\n');

  const prompt = composePrompt({
    runtime: runtime.descriptor,
    rolePack: runtime.rolePack,
    slot: 'scoring',
    formatId: session.formatId,
    evidence: [],
    userRequest: practiceScoreRequest(rubric),
  });

  const userBase = [
    `题目：\n${questionMd}`,
    `完整过程：\n${transcriptMd}`,
    `提交评分的作答：\n${answerMd}`,
  ].join('\n\n');

  let generated = readGeneratedEvaluation(
    await completeJsonWithSystem<unknown>(PRACTICE_ROLE, prompt.systemPrompt, userBase),
  );
  let grounded = groundDimensionScores({ rubric, answerMd, raw: generated.dimensions });

  // 一次带诊断的重试：告诉模型缺了哪几维、哪几条引文对不上，让它按同一结构重来
  if (!grounded.ok) {
    generated = readGeneratedEvaluation(
      await completeJsonWithSystem<unknown>(
        PRACTICE_ROLE,
        prompt.systemPrompt,
        `${userBase}\n\n${practiceScoreRepairRequest(grounded.failure)}`,
      ),
    );
    grounded = groundDimensionScores({ rubric, answerMd, raw: generated.dimensions });
  }

  if (!grounded.ok) {
    const { missing, ungrounded } = grounded.failure;
    throw new PracticeError(
      ungrounded.length > 0 ? 'ungrounded-score' : 'missing-dimension',
      '这次评分没有通过校验，没有落库',
      `missing=${missing.join(',')} ungrounded=${ungrounded.join(',')}`,
    );
  }

  const scores: PracticeDimensionScore[] = grounded.scores;
  const totalScore = weightedTotalScore(scores);
  const needsRePractice = needsRePracticeFor(rubric, scores, totalScore);
  const timestamp = Date.now();
  const attemptId = Crypto.randomUUID();
  const identity = await getDeviceIdentity(db);

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO practice_attempt (
         id, session_id, campaign_id, node_id, format_id, rubric_id, competency_ids,
         question_md, answer_md, transcript_md, total_score, feedback_md, improved_script_md,
         needs_repractice, previous_attempt_id, prompt_version_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attemptId,
      session.id,
      session.campaignId,
      session.nodeId,
      session.formatId,
      rubric.id,
      questionMd,
      answerMd,
      transcriptMd,
      totalScore,
      generated.feedbackMd,
      generated.improvedScriptMd || null,
      needsRePractice ? 1 : 0,
      session.previousAttemptId,
      prompt.provenance.promptVersionId,
      timestamp,
    );
    for (const score of scores) {
      db.runSync(
        `INSERT INTO practice_score (
           id, attempt_id, rubric_id, dimension_id, dimension_label, weight, critical,
           score, anchor_md, answer_quote, answer_start, answer_end, rationale_md
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Crypto.randomUUID(),
        attemptId,
        rubric.id,
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
    db.runSync(
      `UPDATE practice_session SET status = 'evaluated', updated_at = ? WHERE id = ?`,
      timestamp,
      session.id,
    );
  });

  const mastery = session.nodeId
    ? writeMasterySignal(db, session.nodeId, totalScore, identity.deviceId)
    : null;

  return {
    attemptId,
    sessionId: session.id,
    campaignId: session.campaignId,
    nodeId: session.nodeId,
    formatId: session.formatId,
    rubricId: rubric.id,
    scores,
    totalScore,
    feedbackMd: generated.feedbackMd,
    improvedScriptMd: generated.improvedScriptMd,
    needsRePractice,
    mastery,
    createdAt: timestamp,
  };
}

/**
 * 掌握度回写，与手机端「考我」同一套信号与分档（core 的 applyMasterySignal）：
 * 两端对同一次练习必须算出同一个掌握度。来源标 'quiz' 而不是新加一个枚举值——
 * MASTERY_SOURCES 是同步字段，加值会让尚未升级的那一端读到不认识的值。
 */
function writeMasterySignal(
  db: SQLiteDatabase,
  nodeId: string,
  score: number,
  deviceId: string,
): PracticeEvaluation['mastery'] {
  const node = db.getFirstSync<{
    mastery: number;
    mastery_source: string;
    exam_prob: number;
    est_minutes: number;
    coverage_type: string;
  }>(
    `SELECT mastery, mastery_source, exam_prob, est_minutes, coverage_type
     FROM knowledge_node WHERE id = ?`,
    nodeId,
  );
  if (!node) return null;

  const next = applyMasterySignal(
    { mastery: node.mastery, masterySource: node.mastery_source as MasterySource },
    { kind: 'practice', score },
  );
  const status: NodeStatus = masteryToStatus(next.mastery);
  const priority = computePriority(
    {
      id: nodeId,
      coverageType: node.coverage_type as CoverageType,
      examProb: node.exam_prob,
      mastery: next.mastery,
      estMinutes: node.est_minutes,
    },
    getMobileConfig().priority,
  );

  writingAs(db, deviceId, () => {
    db.runSync(
      `UPDATE knowledge_node SET mastery = ?, mastery_source = 'quiz', status = ?, priority_score = ?
       WHERE id = ?`,
      next.mastery,
      status,
      priority.score,
      nodeId,
    );
  });

  return { nodeId, mastery: next.mastery, status, priorityScore: priority.score };
}
