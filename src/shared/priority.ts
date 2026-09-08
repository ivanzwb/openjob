import type { CoverageType } from './enums';
import type { KnowledgeNode, PriorityBreakdown } from './entities';
import { DEFAULT_PRIORITY_WEIGHTS, type PriorityWeights } from './config';

const COVERAGE_LABEL: Record<CoverageType, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

/**
 * 架构文档 11.3 公式里的另外两个乘数。
 *
 * 做成可选而不是必填：考点树只有 JD × 简历这一层信息，算不出证据强弱和面试轮次，
 * 缺省 1 表示「这一维没有输入」，得分与加因子之前逐字相同。能算出来的调用方
 * （能力诊断）传进来，两端用同一份公式，不会各算一套。
 */
export interface PriorityFactors {
  /** 简历声称得强、能撑住的证据却弱时 > 1，最高 2 */
  evidenceRisk?: number;
  /** 下一轮面试就会考的能力 > 1，已经考过的 < 1 */
  stageWeight?: number;
}

/** 负数和 NaN 一律当没传：一个坏因子不该把整条排序清零 */
function factorOf(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 1;
}

function displayFactor(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function computePriority(
  node: Pick<KnowledgeNode, 'id' | 'coverageType' | 'examProb' | 'mastery' | 'estMinutes'>,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
  factors: PriorityFactors = {},
): PriorityBreakdown {
  const target = weights.targetMastery[node.coverageType] ?? 3;
  const masteryGap = Math.max(0, target - node.mastery);
  const minutes = Math.max(node.estMinutes, 1);
  const boost = weights.coverageBoost[node.coverageType] ?? 1;
  const prob = Number.isFinite(node.examProb) ? Math.max(node.examProb, 0) : 0;
  const evidenceRisk = factorOf(factors.evidenceRisk);
  const stageWeight = factorOf(factors.stageWeight);

  const score =
    (Math.pow(prob, weights.probExp) *
      Math.pow(masteryGap, weights.gapExp) *
      boost *
      evidenceRisk *
      stageWeight) /
    Math.pow(minutes, weights.costExp);

  const reason =
    `${COVERAGE_LABEL[node.coverageType]} · ` +
    `考察概率 ${Math.round(prob * 100)}% · ` +
    `掌握差距 ${masteryGap.toFixed(1)}/${target} · ` +
    `预估 ${node.estMinutes} 分钟` +
    (boost !== 1 ? ` · 类型加权 ×${boost}` : '') +
    (evidenceRisk !== 1 ? ` · 证据风险 ×${displayFactor(evidenceRisk)}` : '') +
    (stageWeight !== 1 ? ` · 轮次权重 ×${displayFactor(stageWeight)}` : '');

  return {
    nodeId: node.id,
    examProb: prob,
    masteryGap,
    estMinutes: node.estMinutes,
    score: Number.isFinite(score) ? score : 0,
    reason,
  };
}
