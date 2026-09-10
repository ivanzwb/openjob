/**
 * 通用练习会话在界面上的状态归约，以及逐维度分数的引文还原。
 *
 * 会话本身是一串 turn，界面需要的却是「现在该谁说话、还能追问几轮、能不能提交评分」。
 * 把这段归约留在组件里，就得靠一堆 `session.turns.filter(...)` 散在 JSX 中间，改一次
 * followUpPolicy 就要重读整个组件才敢动。
 *
 * 另一半是引文还原。T12 的每个维度分都带着 rubric 锚点原文和作答里的逐字片段（含
 * start/end 偏移），这不是装饰：分数本身不可复核，可复核的是「按这条锚点、凭这句话给
 * 4 分」。界面把偏移切回原文并核对一遍，模型给的引文与实际作答对不上时就明说，
 * 而不是照着 quote 渲染一段看起来很像原文的字。
 */

import type {
  PracticeAnswerCitation,
  PracticeDimensionScore,
  PracticeEvaluation,
  PracticeSession,
  PracticeTurn,
} from '../practice/types';

export interface PracticeView {
  /** 首问；会话一定有一条 */
  questionMd: string;
  /** 面试官最后一次发言：可能是首问、追问或收束语 */
  latestPromptMd: string;
  turns: PracticeTurn[];
  followUpsAsked: number;
  followUpsLeft: number;
  /** 还能继续作答（追问未到上限且会话未结束） */
  canFollowUp: boolean;
  /** 还能提交评分 */
  canEvaluate: boolean;
  closed: boolean;
}

export function derivePracticeView(session: PracticeSession | null): PracticeView | null {
  if (!session) return null;

  const turns = [...session.turns].sort((left, right) => left.index - right.index);
  const followUpsAsked = turns.filter((turn) => turn.kind === 'followUp').length;
  const interviewerTurns = turns.filter((turn) => turn.speaker === 'interviewer');
  const open = session.status === 'open';
  const closedByEngine = turns.some((turn) => turn.kind === 'closing');

  return {
    questionMd: turns.find((turn) => turn.kind === 'question')?.contentMd ?? '',
    latestPromptMd: interviewerTurns.at(-1)?.contentMd ?? '',
    turns,
    followUpsAsked,
    followUpsLeft: Math.max(0, session.maxFollowUps - followUpsAsked),
    canFollowUp: open && !closedByEngine && followUpsAsked < session.maxFollowUps,
    canEvaluate: open,
    closed: !open,
  };
}

export interface AnswerCitationSlice {
  /** 引文之前的一小段上下文 */
  before: string;
  /** 按 start/end 从作答里切出来的原文 */
  quote: string;
  after: string;
  /** 切出来的原文与模型给的 quote 逐字相同 */
  exact: boolean;
}

/**
 * 按偏移把引文从作答里切回来。
 *
 * 显示切片而不是模型返回的 quote 字段：两者不一致时，用户看到的必须是自己真的写过的
 * 那段字。exact=false 就是「这个分数的依据对不上原文」，界面据此提示，而不是悄悄用
 * quote 顶上。
 */
export function sliceAnswerCitation(
  answerMd: string,
  citation: PracticeAnswerCitation,
  context = 32,
): AnswerCitationSlice {
  const start = Math.max(0, Math.min(citation.start, answerMd.length));
  const end = Math.max(start, Math.min(citation.end, answerMd.length));
  const quote = answerMd.slice(start, end);
  return {
    before: answerMd.slice(Math.max(0, start - context), start),
    quote,
    after: answerMd.slice(end, end + context),
    exact: quote === citation.quote,
  };
}

/** 权重大的维度排前面；同权重按维度 ID 稳定排序 */
export function sortScoresByWeight(
  scores: readonly PracticeDimensionScore[],
): PracticeDimensionScore[] {
  return [...scores].sort(
    (left, right) =>
      right.weight - left.weight ||
      (left.dimensionId < right.dimensionId ? -1 : left.dimensionId > right.dimensionId ? 1 : 0),
  );
}

export interface EvaluationSummary {
  /** 「3.4 / 5」 */
  totalLabel: string;
  /** 触底的关键维度：这几条单独决定要不要复练 */
  criticalMisses: PracticeDimensionScore[];
  /** 引文对不上作答的维度 ID */
  ungroundedDimensionIds: string[];
  needsRePractice: boolean;
}

export function summarizeEvaluation(
  evaluation: PracticeEvaluation,
  answerMd: string,
): EvaluationSummary {
  return {
    totalLabel: `${evaluation.totalScore.toFixed(1)} / 5`,
    criticalMisses: evaluation.scores.filter((score) => score.critical && score.score <= 2),
    ungroundedDimensionIds: evaluation.scores
      .filter((score) => !sliceAnswerCitation(answerMd, score.answer).exact)
      .map((score) => score.dimensionId),
    needsRePractice: evaluation.needsRePractice,
  };
}
