/**
 * 通用练习协议的实现：出题 → 追问 → 评分 → 复练。
 *
 * 这四步原本在 quiz 和 design 两条链路上各写了一遍，题型一多就要再抄一条。这里只
 * 保留一份流程，题型差异全部由岗位包的 InterviewFormatDefinition 与 RubricDefinition
 * 决定，所以新增题型是往岗位包里加声明，而不是加一条代码路径。
 *
 * 两处刻意不省的成本：
 *
 * 1. System Prompt 一律走 T06 组合器。练习引擎不自带 Prompt 正文，只往 userRequest
 *    层追加「逐维度输出」这类要求，这样岗位包片段定下的结构不会被悄悄改写，
 *    provenance 里也能记住这次评分用的是哪个版本的量规。
 * 2. 评分先校验再落库，校验不过给模型一次带诊断的重试机会。放行一个引文对不上的
 *    分数只是少一句原文，但掌握度会被这个数字改写，而复练、优先级和当天计划都以
 *    掌握度为输入。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { LlmRole } from '@core/enums';
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
  type PracticeProtocol,
  type PracticeSession,
  type PracticeSessionInput,
  type PracticeTurn,
  type PracticeTurnInput,
} from '@core/practice';
import { toPromptEvidenceList } from '@core/evidence/promptEvidence';
import { formatIdForLegacyExamForm } from '@core/plugins/legacyRoleData';
import { composePrompt, type ComposedPrompt, type PromptEvidence } from '@core/prompts/composer';
import type { RolePack } from '@core/plugins/types';
import { listConfirmedEvidence } from '../evidence/repository';
import { writeMasterySignal } from './mastery';
import {
  legacyExamFormForFormatId,
  resolveCampaignPracticeRuntime,
  type CampaignPracticeRuntime,
} from './rolePack';
import {
  appendTurn,
  getSession,
  insertAttempt,
  insertScores,
  insertSession,
  setSessionStatus,
} from './repository';

/** 追问到上限后由引擎直接收束，不再问模型：这句话没有任何需要生成的内容。 */
const CLOSING_MD = '本轮追问已到上限，请整理最终作答后提交评分。';

/** 练习沿用 quiz 这一档模型配置：出题与评分本来就是同一类任务。 */
const PRACTICE_ROLE: LlmRole = 'quiz';

export interface PracticeServiceDeps {
  raw: Database;
  completeJson: <T>(request: {
    role: LlmRole;
    prompt: ComposedPrompt;
    user: string;
    signal?: AbortSignal;
  }) => Promise<T>;
  now?: () => number;
  newId?: () => string;
}

interface Resolved extends CampaignPracticeRuntime {
  formatId: string;
  format: ReturnType<typeof resolvePracticeFormat>['format'];
  rubric: ReturnType<typeof resolvePracticeFormat>['rubric'];
}

export interface PracticeService extends PracticeProtocol {
  getSession(sessionId: string): PracticeSession | null;
}

function evidenceFor(raw: Database, campaignId: string): PromptEvidence[] {
  try {
    return toPromptEvidenceList(listConfirmedEvidence(raw, { campaignId }));
  } catch {
    // 证据读不出来不该拦住练习：出题与评分都不产出个人事实，组合器也不要求有证据
    return [];
  }
}

export function createPracticeService(deps: PracticeServiceDeps): PracticeService {
  const { raw } = deps;
  const now = (): number => deps.now?.() ?? Date.now();
  const newId = (): string => deps.newId?.() ?? randomUUID();

  function resolve(campaignId: string, formatId: string): Resolved {
    const runtime = resolveCampaignPracticeRuntime(raw, campaignId);
    const { format, rubric } = resolvePracticeFormat(runtime.rolePack, formatId);
    return { ...runtime, formatId, format, rubric };
  }

  /**
   * build 型 prompt 的参数。
   *
   * design.case / design.score 仍按旧的题型与语言取值分支，所以这里给的是 formatId
   * 对应的旧 ExamForm，而不是新的 protocol——传错分支不会报错，只会静默换成另一套
   * 题目模板。
   */
  function promptParams(resolved: Resolved): Record<string, string | undefined> {
    return {
      type: legacyExamFormForFormatId(resolved.formatId),
      language: resolved.interviewLanguage,
    };
  }

  function loadSession(sessionId: string): PracticeSession {
    const session = getSession(raw, sessionId);
    if (!session) {
      throw new PracticeError('session-not-found', `练习会话 ${sessionId} 不存在`);
    }
    return session;
  }

  /** 会话已存的绑定就是当时那一套，重新解析只是为了拿到片段与量规正文 */
  function resolveForSession(session: PracticeSession): Resolved {
    return resolve(session.campaignId, session.formatId);
  }

  function questionPrompt(
    resolved: Resolved,
    rolePack: RolePack,
    campaignId: string,
    followUpRound: number | undefined,
    userRequest: string | undefined,
  ): ComposedPrompt {
    return composePrompt({
      runtime: resolved.descriptor,
      rolePack,
      slot: 'questionGeneration',
      formatId: resolved.formatId,
      evidence: evidenceFor(raw, campaignId),
      userRequest: practiceQuestionRequest({
        format: resolved.format,
        followUpRound,
        userRequest,
      }),
      params: promptParams(resolved),
    });
  }

  async function createSession(input: PracticeSessionInput): Promise<PracticeSession> {
    const formatId =
      input.formatId ??
      (input.legacyExamForm ? formatIdForLegacyExamForm(input.legacyExamForm) : undefined);
    if (!formatId) {
      throw new PracticeError(
        'unknown-format',
        'createSession 必须给出 formatId 或 legacyExamForm',
      );
    }

    const resolved = resolve(input.campaignId, formatId);
    const prompt = questionPrompt(
      resolved,
      resolved.rolePack,
      input.campaignId,
      undefined,
      input.userRequest,
    );

    const generated = readGeneratedQuestion(
      await deps.completeJson<unknown>({
        role: PRACTICE_ROLE,
        prompt,
        user: practiceQuestionRequest({
          format: resolved.format,
          userRequest: input.userRequest,
        }),
      }),
    );

    const sessionId = newId();
    const timestamp = now();
    insertSession(raw, {
      id: sessionId,
      campaignId: input.campaignId,
      nodeId: input.nodeId ?? null,
      formatId,
      protocol: resolved.format.protocol,
      rubricId: resolved.rubric.id,
      rolePackId: resolved.rolePack.manifest.id,
      rolePackVersion: resolved.rolePack.manifest.version,
      configSnapshotHash: resolved.descriptor.configSnapshotHash,
      maxFollowUps: resolved.format.followUpPolicy.maxRounds,
      followUpStrategy: resolved.format.followUpPolicy.strategy,
      previousAttemptId: input.previousAttemptId ?? null,
      now: timestamp,
    });

    appendTurn(raw, {
      id: newId(),
      sessionId,
      speaker: 'interviewer',
      kind: 'question',
      contentMd: generated.questionMd,
      now: timestamp,
    });

    return loadSession(sessionId);
  }

  /**
   * 落一轮候选人作答，再决定追问还是收束。
   *
   * 先把作答写进库再去问模型：模型这一步失败时，用户刚打完的那段回答不该跟着丢。
   */
  async function nextTurn(input: PracticeTurnInput): Promise<PracticeTurn> {
    const session = loadSession(input.sessionId);
    if (session.status !== 'open') {
      throw new PracticeError('session-closed', `会话 ${session.id} 已结束，不能继续作答`);
    }
    if (!input.answerMd.trim()) {
      throw new PracticeError('empty-answer', '作答不能为空');
    }

    appendTurn(raw, {
      id: newId(),
      sessionId: session.id,
      speaker: 'candidate',
      kind: 'answer',
      contentMd: input.answerMd,
      now: now(),
    });

    const asked = session.turns.filter((turn) => turn.kind === 'followUp').length;
    if (asked >= session.maxFollowUps) {
      return appendTurn(raw, {
        id: newId(),
        sessionId: session.id,
        speaker: 'interviewer',
        kind: 'closing',
        contentMd: CLOSING_MD,
        now: now(),
      });
    }

    const resolved = resolveForSession(session);
    const request = practiceQuestionRequest({
      format: resolved.format,
      followUpRound: asked + 1,
    });
    const generated = readGeneratedQuestion(
      await deps.completeJson<unknown>({
        role: PRACTICE_ROLE,
        prompt: questionPrompt(
          resolved,
          resolved.rolePack,
          session.campaignId,
          asked + 1,
          undefined,
        ),
        user: `${request}\n\n候选人上一轮作答：\n${input.answerMd}`,
      }),
    );

    return appendTurn(raw, {
      id: newId(),
      sessionId: session.id,
      speaker: 'interviewer',
      kind: 'followUp',
      contentMd: generated.questionMd,
      now: now(),
    });
  }

  async function evaluate(input: PracticeEvaluationInput): Promise<PracticeEvaluation> {
    const session = loadSession(input.sessionId);
    const answerMd =
      input.answerMd ??
      [...session.turns].reverse().find((turn) => turn.speaker === 'candidate')?.contentMd ??
      '';
    if (!answerMd.trim()) {
      throw new PracticeError('empty-answer', '没有可评分的作答');
    }

    const resolved = resolveForSession(session);
    const questionMd = session.turns.find((turn) => turn.kind === 'question')?.contentMd ?? '';
    const transcriptMd = session.turns
      .map(
        (turn) =>
          `**${turn.speaker === 'interviewer' ? '面试官' : '候选人'}**：${turn.contentMd}`,
      )
      .join('\n\n');

    const prompt = composePrompt({
      runtime: resolved.descriptor,
      rolePack: resolved.rolePack,
      slot: 'scoring',
      formatId: session.formatId,
      evidence: evidenceFor(raw, session.campaignId),
      userRequest: practiceScoreRequest(resolved.rubric),
      params: promptParams(resolved),
    });

    const userBase = [
      `题目：\n${questionMd}`,
      `完整过程：\n${transcriptMd}`,
      `提交评分的作答：\n${answerMd}`,
    ].join('\n\n');

    let generated = readGeneratedEvaluation(
      await deps.completeJson<unknown>({ role: PRACTICE_ROLE, prompt, user: userBase }),
    );
    let grounded = groundDimensionScores({
      rubric: resolved.rubric,
      answerMd,
      raw: generated.dimensions,
    });

    // 一次带诊断的重试：告诉模型缺了哪几维、哪几条引文对不上，让它按同一结构重来
    if (!grounded.ok) {
      const repair = practiceScoreRepairRequest(grounded.failure);
      generated = readGeneratedEvaluation(
        await deps.completeJson<unknown>({
          role: PRACTICE_ROLE,
          prompt,
          user: `${userBase}\n\n${repair}`,
        }),
      );
      grounded = groundDimensionScores({
        rubric: resolved.rubric,
        answerMd,
        raw: generated.dimensions,
      });
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
    const needsRePractice = needsRePracticeFor(resolved.rubric, scores, totalScore);
    const timestamp = now();
    const attemptId = newId();

    insertAttempt(raw, {
      id: attemptId,
      sessionId: session.id,
      campaignId: session.campaignId,
      nodeId: session.nodeId,
      formatId: session.formatId,
      rubricId: resolved.rubric.id,
      competencyIds: [],
      questionMd,
      answerMd,
      transcriptMd,
      totalScore,
      feedbackMd: generated.feedbackMd,
      improvedScriptMd: generated.improvedScriptMd || null,
      needsRepractice: needsRePractice,
      previousAttemptId: session.previousAttemptId,
      promptVersionId: prompt.provenance.promptVersionId,
      now: timestamp,
    });
    insertScores(raw, attemptId, scores, newId);
    setSessionStatus(raw, session.id, 'evaluated', timestamp);

    const mastery = session.nodeId
      ? writeMasterySignal(raw, session.nodeId, { kind: 'practice', score: totalScore })
      : null;

    return {
      attemptId,
      sessionId: session.id,
      campaignId: session.campaignId,
      nodeId: session.nodeId,
      formatId: session.formatId,
      rubricId: resolved.rubric.id,
      scores,
      totalScore,
      feedbackMd: generated.feedbackMd,
      improvedScriptMd: generated.improvedScriptMd,
      needsRePractice,
      mastery,
      createdAt: timestamp,
    };
  }

  return {
    createSession,
    nextTurn,
    evaluate,
    getSession: (sessionId: string) => getSession(raw, sessionId),
  };
}
