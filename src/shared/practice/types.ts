/**
 * 通用练习协议的共享契约。
 *
 * 插件化之前，「出题—追问—评分—复练」在 quiz 与 design 两条链路上各写了一遍：
 * 出题的 JSON 结构不同、评分只有一个 1-5 的总分、掌握度各自回写。岗位包一多，
 * 每加一个题型就要再抄一条链路。这里把这四步收成一个协议，题型差异全部由
 * 岗位包的 InterviewFormatDefinition 与 RubricDefinition 决定。
 *
 * 两条硬约束写在类型里，不靠调用方自觉：
 *
 * 1. 每个维度分必须同时带上 Rubric 锚点原文与用户原回答中的逐字片段
 *    （PracticeDimensionScore.anchor / answer）。缺任何一边都不构成一个分数——
 *    「4 分」本身不可复核，能复核的是「按这条锚点、凭这句话给 4 分」。
 * 2. quiz / design 的历史记录只投影成只读 PracticeAttempt（readOnly=true），
 *    不回写旧表，也不补建新行。
 */

import type {
  ExamForm,
  InterviewProtocol,
  FollowUpStrategy,
  PracticeAttemptSource,
  PracticeSessionStatus,
  PracticeTurnKind,
  PracticeTurnSpeaker,
} from '../enums';
import type { RubricScore } from '../plugins/types';

export type { RubricScore };

// ---------------------------------------------------------------------------
// 分数溯源
// ---------------------------------------------------------------------------

/** 指回岗位包 rubric 里的具体等级锚点 */
export interface RubricAnchorRef {
  rubricId: string;
  dimensionId: string;
  score: RubricScore;
  /** 该等级的行为锚点原文，与 RubricDefinition 中的文本逐字相同 */
  text: string;
}

/**
 * 分数所依据的用户原回答片段。
 *
 * start/end 是在 answerMd 上的下标：模型只给一句引文时无从判断它是真的引用还是
 * 改写，定位到原文位置之后「凭空一个数字」才不可能通过校验。
 */
export interface PracticeAnswerCitation {
  quote: string;
  start: number;
  end: number;
}

export interface PracticeDimensionScore {
  dimensionId: string;
  label: string;
  weight: number;
  critical: boolean;
  score: RubricScore;
  anchor: RubricAnchorRef;
  answer: PracticeAnswerCitation;
  rationaleMd: string;
}

// ---------------------------------------------------------------------------
// 会话与回合
// ---------------------------------------------------------------------------

export interface PracticeTurn {
  id: string;
  sessionId: string;
  /** 从 0 开始，同一会话内连续 */
  index: number;
  speaker: PracticeTurnSpeaker;
  kind: PracticeTurnKind;
  contentMd: string;
  createdAt: number;
}

/**
 * 一次练习会话。
 *
 * rolePackId/rolePackVersion/configSnapshotHash 是当时的执行版本快照：岗位包升级
 * 之后回头看这次评分，只有精确版本能解释当时用的是哪套题型与量规。
 */
export interface PracticeSession {
  id: string;
  campaignId: string;
  /** 绑定考点时评分会回写掌握度；通用练习可以为 null */
  nodeId: string | null;
  formatId: string;
  protocol: InterviewProtocol;
  rubricId: string;
  rolePackId: string;
  rolePackVersion: string;
  configSnapshotHash: string;
  maxFollowUps: number;
  followUpStrategy: FollowUpStrategy;
  status: PracticeSessionStatus;
  /** 复练时指向上一次 attempt */
  previousAttemptId: string | null;
  turns: PracticeTurn[];
  createdAt: number;
  updatedAt: number;
}

export interface PracticeSessionInput {
  campaignId: string;
  /** 岗位包声明的题型 ID；与 legacyExamForm 二选一 */
  formatId?: string;
  /** 兼容入口：旧 ExamForm 按岗位包映射成 formatId */
  legacyExamForm?: ExamForm;
  nodeId?: string | null;
  previousAttemptId?: string | null;
  /** 用户本次明确要求，优先级最低 */
  userRequest?: string;
}

export interface PracticeTurnInput {
  sessionId: string;
  /** 候选人本轮作答；引擎先落这一轮，再决定追问还是收束 */
  answerMd: string;
}

export interface PracticeEvaluationInput {
  sessionId: string;
  /** 提交评分的完整作答；省略时取会话里最后一次候选人发言 */
  answerMd?: string;
}

// ---------------------------------------------------------------------------
// 评分结果与历史投影
// ---------------------------------------------------------------------------

export interface PracticeEvaluation {
  attemptId: string;
  sessionId: string;
  campaignId: string;
  nodeId: string | null;
  formatId: string;
  rubricId: string;
  scores: PracticeDimensionScore[];
  /** 按 rubric 权重归一化后的 1-5 总分 */
  totalScore: number;
  feedbackMd: string;
  improvedScriptMd: string;
  /** 低于 passThreshold 或关键维度触底时为 true */
  needsRePractice: boolean;
  /** 会话绑定考点时的掌握度回写结果；未绑定为 null */
  mastery: PracticeMasteryUpdate | null;
  createdAt: number;
}

export interface PracticeMasteryUpdate {
  nodeId: string;
  mastery: number;
  status: string;
  priorityScore: number;
}

/**
 * 统一的练习记录读模型。
 *
 * source=quiz/design 的行由适配层按旧表投影，readOnly 恒为 true——历史数据不重写，
 * 也不因为新协议出现而被补成假的维度分。旧记录只有一个总分，dimensionScores 就是
 * 空的，这比按总分反推四个维度诚实。
 */
export interface PracticeAttempt {
  id: string;
  source: PracticeAttemptSource;
  readOnly: boolean;
  campaignId: string;
  nodeId: string | null;
  formatId: string;
  rubricId: string;
  competencyIds: string[];
  questionMd: string;
  answerMd: string;
  transcriptMd: string | null;
  /** dimensionId → 1-5；历史投影为空对象 */
  dimensionScores: Record<string, number>;
  totalScore: number;
  feedbackMd: string;
  previousAttemptId: string | null;
  createdAt: number;
}

/** attempt 加上逐维度的锚点与原文引用，供结果页复核每一个分数 */
export interface PracticeAttemptDetail {
  attempt: PracticeAttempt;
  scores: PracticeDimensionScore[];
}

export interface PracticeAttemptQuery {
  campaignId: string;
  nodeId?: string | null;
  /** 省略则返回三种来源 */
  sources?: PracticeAttemptSource[];
  limit?: number;
}

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

export interface PracticeProtocol {
  createSession(input: PracticeSessionInput): Promise<PracticeSession>;
  nextTurn(input: PracticeTurnInput): Promise<PracticeTurn>;
  evaluate(input: PracticeEvaluationInput): Promise<PracticeEvaluation>;
}

export type PracticeErrorCode =
  | 'unknown-format'
  | 'unknown-rubric'
  | 'session-not-found'
  | 'session-closed'
  | 'empty-answer'
  | 'unreadable-question'
  | 'missing-dimension'
  | 'ungrounded-score';

export class PracticeError extends Error {
  readonly code: PracticeErrorCode;
  readonly detail?: string;

  constructor(code: PracticeErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'PracticeError';
    this.code = code;
    this.detail = detail;
  }
}
