import type { KnowledgeNode, PriorityBreakdown } from '@shared/entities';
import type { PriorityWeights } from '@shared/config';
import { DEFAULT_PRIORITY_WEIGHTS } from '@shared/config';
import { computePriority as computePriorityCore } from '@shared/priority';
import { getConfig } from '../config';

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
  return computePriorityCore(node, override ?? weights());
}

export function attachPriorityReason<T extends KnowledgeNode>(
  node: T,
): T & { priorityReason: string } {
  return { ...node, priorityReason: computePriority(node).reason };
}
