import type { CoverageType } from './enums';
import type { KnowledgeNode, PriorityBreakdown } from './entities';
import { DEFAULT_PRIORITY_WEIGHTS, type PriorityWeights } from './config';

const COVERAGE_LABEL: Record<CoverageType, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

export function computePriority(
  node: Pick<KnowledgeNode, 'id' | 'coverageType' | 'examProb' | 'mastery' | 'estMinutes'>,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): PriorityBreakdown {
  const target = weights.targetMastery[node.coverageType] ?? 3;
  const masteryGap = Math.max(0, target - node.mastery);
  const minutes = Math.max(node.estMinutes, 1);
  const boost = weights.coverageBoost[node.coverageType] ?? 1;
  const prob = Number.isFinite(node.examProb) ? Math.max(node.examProb, 0) : 0;

  const score =
    (Math.pow(prob, weights.probExp) * Math.pow(masteryGap, weights.gapExp) * boost) /
    Math.pow(minutes, weights.costExp);

  const reason =
    `${COVERAGE_LABEL[node.coverageType]} · ` +
    `考察概率 ${Math.round(prob * 100)}% · ` +
    `掌握差距 ${masteryGap.toFixed(1)}/${target} · ` +
    `预估 ${node.estMinutes} 分钟` +
    (boost !== 1 ? ` · 类型加权 ×${boost}` : '');

  return {
    nodeId: node.id,
    examProb: prob,
    masteryGap,
    estMinutes: node.estMinutes,
    score: Number.isFinite(score) ? score : 0,
    reason,
  };
}
