import type { CoverageType } from '@shared/enums';
import type { KnowledgeNode, PriorityBreakdown } from '@shared/entities';
import type { PriorityWeights } from '@shared/config';
import { DEFAULT_PRIORITY_WEIGHTS } from '@shared/config';
import { getConfig } from '../config';

const COVERAGE_LABEL: Record<CoverageType, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

/**
 * 权重来自用户可编辑的配置。config 尚未就绪（如迁移脚本、单测）时退回默认值，
 * 排序是全局依赖，不能因为读配置失败就崩。
 */
function weights(): PriorityWeights {
  try {
    return getConfig().priority ?? DEFAULT_PRIORITY_WEIGHTS;
  } catch {
    return DEFAULT_PRIORITY_WEIGHTS;
  }
}

/**
 * 优先级 = 考察概率^probExp × 掌握差距^gapExp × 覆盖类型倍率 ÷ 预估时长^costExp。
 * reason 必须人类可读——排序依据对用户可见是产品形态成立的前提。
 */
export function computePriority(
  node: Pick<KnowledgeNode, 'id' | 'coverageType' | 'examProb' | 'mastery' | 'estMinutes'>,
  override?: PriorityWeights,
): PriorityBreakdown {
  const w = override ?? weights();
  const target = w.targetMastery[node.coverageType];
  const masteryGap = Math.max(0, target - node.mastery);
  const minutes = Math.max(node.estMinutes, 1);
  const boost = w.coverageBoost[node.coverageType];

  const score =
    (Math.pow(Math.max(node.examProb, 0), w.probExp) *
      Math.pow(masteryGap, w.gapExp) *
      boost) /
    Math.pow(minutes, w.costExp);

  const reason =
    `${COVERAGE_LABEL[node.coverageType]} · ` +
    `考察概率 ${Math.round(node.examProb * 100)}% · ` +
    `掌握差距 ${masteryGap.toFixed(1)}/${target} · ` +
    `预估 ${node.estMinutes} 分钟` +
    (boost !== 1 ? ` · 类型加权 ×${boost}` : '');

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
