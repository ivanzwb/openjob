/**
 * evidenceRisk 与 stageWeight 的计算。
 *
 * 架构文档 11.3 只给了两句话：「简历声称很强但证据薄弱时提高」「即将到来的面试
 * 轮次权重更高」。这里把它们落成纯函数，理由和 rubric 一样——这两个值会乘进
 * 优先级，进而决定用户今天先准备什么。一个不能复算、不能解释的乘数，出问题时
 * 没人能判断是模型抽风还是数据不对。
 */

import type { CandidateEvidenceKind } from '../enums';
import type { InterviewStageTemplate } from '../plugins/types';

/**
 * 各类证据的佐证力度。
 *
 * skill 记 0 不是嫌它弱，而是它在语义上就是「声称」本身：简历写一行「精通
 * Kubernetes」，那既是主张也是全部依据，把它算成证据等于让声称自我背书，
 * evidenceRisk 永远升不起来，这条规则也就白写了。
 */
export const EVIDENCE_KIND_SUPPORT: Readonly<Record<CandidateEvidenceKind, number>> = {
  /** 带结果的成就，最硬 */
  achievement: 1,
  /** 第三方可验证 */
  credential: 0.9,
  /** 亲历事实 */
  experience: 0.8,
  /** 自述行为，只能部分佐证 */
  behavior: 0.4,
  /** 「我会 X」——这是声称，不是证据 */
  skill: 0,
};

/** 声称与证据的最大落差换算成多少倍率。1 表示最坏情况翻一倍 */
export const EVIDENCE_RISK_SPAN = 1;

export interface CompetencyEvidenceSignal {
  kind: CandidateEvidenceKind;
  /** 抽取置信度 0–1 */
  confidence: number;
  /** 与该能力的文本相关度 0–1 */
  relevance: number;
}

export interface EvidenceRiskResult {
  /** 0–1，材料把这项能力说得多强 */
  claimStrength: number;
  /** 0–1，能撑住这份声称的证据有多硬 */
  evidenceStrength: number;
  /** 1–2 */
  evidenceRisk: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 两侧都用 noisy-OR 累积：多条证据只会互相补强，不会因为条数多就线性超过 1。
 *
 * 声称侧按原始置信度累积，证据侧再乘一次 kind 折扣，所以证据强度永远不高于
 * 声称强度，差值天然落在 [0, 1)。「列了十项技能、一条经历都没有」正好压在
 * 上界：声称接近 1，证据恒为 0。
 */
export function computeEvidenceRisk(
  signals: readonly CompetencyEvidenceSignal[],
): EvidenceRiskResult {
  let claimMiss = 1;
  let supportMiss = 1;

  for (const signal of signals) {
    const claim = clamp01(signal.confidence) * clamp01(signal.relevance);
    const support = claim * (EVIDENCE_KIND_SUPPORT[signal.kind] ?? 0);
    claimMiss *= 1 - claim;
    supportMiss *= 1 - support;
  }

  const claimStrength = 1 - claimMiss;
  const evidenceStrength = 1 - supportMiss;
  const gap = Math.max(0, claimStrength - evidenceStrength);
  return {
    claimStrength,
    evidenceStrength,
    evidenceRisk: 1 + EVIDENCE_RISK_SPAN * gap,
  };
}

/** 每往后一轮衰减多少。0.6 让「下一轮」明显压过「第三轮」，又不至于把后面清零 */
export const STAGE_PROXIMITY_DECAY = 0.6;
/** 剩余轮次都不考这项能力时的下界。不清零：面试官顺嘴问一句的成本仍然存在 */
export const MIN_STAGE_WEIGHT = 0.6;
export const MAX_STAGE_WEIGHT = 1.4;
/** 没有轮次信息时返回中性值，等于不参与排序 */
export const NEUTRAL_STAGE_WEIGHT = 1;

export interface StageWeightInput {
  stages: readonly InterviewStageTemplate[];
  /** 该能力支持的题型 ID */
  formatIds: readonly string[];
  /** 下一轮面试；null / 未知 ID 表示流程还没开始，从最早那一轮算起 */
  upcomingStageId?: string | null;
}

export interface StageWeightResult {
  stageWeight: number;
  /** 会考察该能力的轮次，按 order 升序 */
  stageIds: string[];
}

/**
 * 取「最近的一轮」而不是把各轮加总。
 *
 * 加总会让一项在四轮里都沾边的通用能力压过下一轮就要考的专项能力，那正好和
 * 「即将到来的轮次权重更高」相反。轮次自己的 defaultWeight 仍然参与，按包内
 * 最大轮次权重归一，所以「下一轮而且是重头戏」才拿得到上界。
 */
export function computeStageWeight(input: StageWeightInput): StageWeightResult {
  const supported = new Set(input.formatIds);
  const exercising = input.stages
    .filter((stage) => stage.formatIds.some((formatId) => supported.has(formatId)))
    .slice()
    .sort((a, b) => a.order - b.order);
  const stageIds = exercising.map((stage) => stage.id);

  const maxStageWeight = input.stages.reduce(
    (max, stage) => (stage.defaultWeight > max ? stage.defaultWeight : max),
    0,
  );
  if (input.stages.length === 0 || maxStageWeight <= 0) {
    return { stageWeight: NEUTRAL_STAGE_WEIGHT, stageIds };
  }

  const upcoming = input.upcomingStageId
    ? input.stages.find((stage) => stage.id === input.upcomingStageId)
    : undefined;
  const baseOrder = upcoming
    ? upcoming.order
    : input.stages.reduce((min, stage) => (stage.order < min ? stage.order : min), Infinity);

  let focus = 0;
  for (const stage of exercising) {
    // 已经面完的轮次不再计入：它不会再考，准备它是纯浪费
    if (stage.order < baseOrder) continue;
    const proximity = Math.pow(STAGE_PROXIMITY_DECAY, stage.order - baseOrder);
    const signal = proximity * (stage.defaultWeight / maxStageWeight);
    if (signal > focus) focus = signal;
  }

  return {
    stageWeight: MIN_STAGE_WEIGHT + (MAX_STAGE_WEIGHT - MIN_STAGE_WEIGHT) * clamp01(focus),
    stageIds,
  };
}
