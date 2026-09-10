/**
 * 面经摄入里那些「两端必须算出同一个数」的判定。
 *
 * 这些常量原先桌面端一份、手机端一份：BASE_PROB_BOOST 在
 * src/main/diagnosis/prior.ts 和 mobile/src/data/nodesLocal.ts 里各写了一个 0.08，
 * 而可信度权重表只有桌面端有——手机端此前从不创建面经记录，所以还没暴露。一旦手机端
 * 也能录复盘，两端就会按不同的幅度修正同一个考点的考察概率，而这类偏差不会报错，只会
 * 让同一场备考在两台设备上排出不同的复习顺序。
 *
 * 放在这里的都是纯函数：取数仍由各端自己用 drizzle 或原生 SQL 做，判定共用一份。
 */

import type { ReportSourceType } from '../enums';

/**
 * 各面经来源的可信度权重，决定考察概率的修正幅度。
 *
 * 自己面完的复盘是一手经历，给满权重；手动粘贴的面经至少经过人工挑选；网络抓取的
 * 洗稿与转载最多，折得最狠。
 */
export const CREDIBILITY_WEIGHT: Record<ReportSourceType, number> = {
  selfDebrief: 1,
  pasted: 0.8,
  web: 0.5,
};

export const BASE_PROB_BOOST = 0.08;

/** 判断「是不是同一篇原文被重复摄入」时比对的前缀长度 */
export const RAW_TEXT_DEDUPE_PREFIX = 120;

/** 抬升后的考察概率。概率封顶 1，多来几篇面经不该把它顶出值域 */
export function boostedExamProb(
  currentProb: number,
  credibilityWeight: number,
  factor = 1,
): number {
  return Math.min(1, currentProb + BASE_PROB_BOOST * credibilityWeight * factor);
}

export interface CorroborationSource {
  sourceType: ReportSourceType;
  /** 面经原文；同一篇被重复摄入时按前缀判重 */
  rawText: string;
}

export interface Corroboration {
  /** 去重后的独立来源数 */
  sources: number;
  /** 修正幅度的折扣系数 */
  factor: number;
  /** 是否已被交叉验证 */
  verified: boolean;
}

function dedupeKey(source: CorroborationSource): string {
  return `${source.sourceType}|${source.rawText.slice(0, RAW_TEXT_DEDUPE_PREFIX)}`;
}

/**
 * 多源交叉验证：这个考点被几个**独立**来源提到过。
 *
 * 面经质量分布极差，洗稿和层层转载很常见，所以「被提到很多次」本身不说明问题——同一篇
 * 原文被摄入三遍仍然只是一个来源，按原文前缀判重就是为了拦这种情况。单一来源提到的考点
 * 只给折扣权重并标为存疑，两个以上独立来源才给足。
 *
 * 自己复盘是一手经历，永远算实证：哪怕只有这一条，也不该因为「没人佐证」而被折价。
 */
export function corroborate(sources: readonly CorroborationSource[]): Corroboration {
  if (sources.length === 0) return { sources: 0, factor: 0.5, verified: false };

  const distinct = new Set(sources.map(dedupeKey)).size;

  if (sources.some((source) => source.sourceType === 'selfDebrief')) {
    return { sources: distinct, factor: 1, verified: true };
  }
  if (distinct >= 2) return { sources: distinct, factor: 1, verified: true };
  return { sources: distinct, factor: 0.5, verified: false };
}

/** 真题匹配不到任何考点 = 图谱预测失败，这类题信息价值最高，单独归到一个域下 */
export const BLIND_SPOT_DOMAIN_NAME = '真题盲区';

/**
 * 盲区节点的固定字段。
 *
 * 概率与难度给得偏高是有意的：它之所以成为盲区，正是因为真的被考到了而图谱没预测到。
 * examForms 只给 concept——这些题目前只有题面，没有任何依据说它该按设计题或编码题练。
 */
export const BLIND_SPOT_DOMAIN_DEFAULTS = {
  kind: 'domain',
  coverageType: 'landmine',
  examProb: 0.9,
  difficulty: 4,
  estMinutes: 20,
} as const;

export const BLIND_SPOT_POINT_DEFAULTS = {
  kind: 'point',
  coverageType: 'landmine',
  examProb: 0.85,
  difficulty: 4,
  estMinutes: 25,
} as const;

export interface QuestionMatch {
  questionIndex: number;
  nodeName: string | null;
  confidence: number;
  suggestedName?: string | null;
}

export type QuestionOutcome =
  /** 命中已有考点 */
  | { kind: 'matched'; nodeName: string; confidence: number }
  /** 没命中但模型给了名字，建一个盲区考点 */
  | { kind: 'newBlindSpot'; suggestedName: string; confidence: number | null }
  /** 既没命中也没名字，只留题不动图谱 */
  | { kind: 'unmatched'; confidence: number | null };

/**
 * 单道真题的归属判定。
 *
 * 把它独立出来是因为三条分支的边界容易被写错：模型可能同时给出 nodeName 和
 * suggestedName，也可能给一个图谱里并不存在的 nodeName。以「现有考点名集合」为准
 * 复核一遍，模型报的名字不存在时按未命中处理，而不是拿一个空节点继续往下走。
 */
export function decideQuestionOutcome(
  match: QuestionMatch | undefined,
  /** 只需要「这个名字在不在图谱里」，Set 与 Map 都能直接传进来 */
  existingNodeNames: { has(name: string): boolean },
): QuestionOutcome {
  const confidence = match?.confidence ?? null;

  if (match?.nodeName && existingNodeNames.has(match.nodeName)) {
    return { kind: 'matched', nodeName: match.nodeName, confidence: match.confidence };
  }

  const suggested = match?.suggestedName?.trim();
  if (suggested) return { kind: 'newBlindSpot', suggestedName: suggested, confidence };

  return { kind: 'unmatched', confidence };
}
