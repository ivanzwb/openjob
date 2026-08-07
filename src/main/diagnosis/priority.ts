import type { CoverageType } from '@shared/enums';
import type { KnowledgeNode, PriorityBreakdown } from '@shared/entities';

/** 各覆盖类型的目标掌握度，用于计算掌握差距 */
const TARGET_MASTERY: Record<CoverageType, number> = {
  deepDive: 5,
  gap: 3,
  landmine: 4,
  extra: 2,
};

const COVERAGE_LABEL: Record<CoverageType, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

/**
 * 优先级 = 考察概率 × 掌握差距 ÷ 预估学习成本。
 * reason 必须人类可读——排序依据对用户可见是产品形态成立的前提。
 */
export function computePriority(
  node: Pick<KnowledgeNode, 'id' | 'coverageType' | 'examProb' | 'mastery' | 'estMinutes'>,
): PriorityBreakdown {
  const target = TARGET_MASTERY[node.coverageType];
  const masteryGap = Math.max(0, target - node.mastery);
  const minutes = Math.max(node.estMinutes, 1);
  const score = (node.examProb * masteryGap) / minutes;

  const reason =
    `${COVERAGE_LABEL[node.coverageType]} · ` +
    `考察概率 ${Math.round(node.examProb * 100)}% · ` +
    `掌握差距 ${masteryGap.toFixed(1)} · ` +
    `预估 ${node.estMinutes} 分钟`;

  return {
    nodeId: node.id,
    examProb: node.examProb,
    masteryGap,
    estMinutes: node.estMinutes,
    score,
    reason,
  };
}

export function attachPriorityReason<T extends KnowledgeNode>(
  node: T,
): T & { priorityReason: string } {
  return { ...node, priorityReason: computePriority(node).reason };
}
