/**
 * 插入点 A 的导航解析：把岗位包声明的 navigation[] 解析成主导航能力页签槽位里的入口。
 *
 * 与旧「单一源码页签」版本相同的两条不变式：
 *
 * 1. 「一个 Campaign 都没有」和「所有 Campaign 都不支持」是两件事。没有任何 descriptor
 *    能说明入口该消失时，入口保持可见——把「先建 Campaign 才能长出源码页」留给用户猜，
 *    是最差的引导。
 * 2. 探测没跑完之前不能给结论：首轮先按上次缓存（或全部可见）渲染，IPC 回来再收敛，
 *    避免入口先消失又插回的抖动。
 *
 * 语义对齐架构文档 §12.2：runtime 是功能层级而非显示开关——view-only / unsupported
 * 在手机端渲染降级状态而非隐藏；桌面上入口消失只有「包不声明」和「所有 Campaign 都
 * 未启用对应能力」两种情况。
 */

import type { HostPageId, NavigationEntry } from '../plugins/types';

export interface NavigationProbe {
  campaignId: string;
  /** 该 Campaign 本机可用（mode === 'full'）的能力 ID；null = descriptor 缺失，不构成否定证据 */
  fullCapabilityIds: string[] | null;
}

export interface ResolvedNavEntry {
  id: string;
  label: string;
  pageId: HostPageId;
  requiredCapabilityId?: string;
  degradedHint?: string;
}

/** 单个入口的可见性判断，独立导出供测试与未来按 Campaign 局部导航复用 */
export function entryVisible(entry: NavigationEntry, probes: readonly NavigationProbe[]): boolean {
  const known = probes.filter((probe) => probe.fullCapabilityIds !== null);
  if (known.length === 0) return true;
  if (entry.requiredCapabilityId === undefined) return true;
  return known.some((probe) => probe.fullCapabilityIds!.includes(entry.requiredCapabilityId!));
}

/**
 * 声明 → 可见入口。跨岗位包去重（同 id 只保留第一个声明），顺序保持声明顺序。
 * probed = false 时按 lastKnownIds 过滤；lastKnownIds 为 null 表示没有历史结论，
 * 此时全部可见（与「没有任何 descriptor 不构成否定」同一条规则）。
 */
export function resolveVisibleNavigation(
  declared: readonly NavigationEntry[],
  probes: readonly NavigationProbe[],
  opts: { probed: boolean; lastKnownIds: readonly string[] | null },
): ResolvedNavEntry[] {
  const seen = new Set<string>();
  const visible: ResolvedNavEntry[] = [];
  const candidates =
    !opts.probed && opts.lastKnownIds !== null
      ? declared.filter((entry) => opts.lastKnownIds!.includes(entry.id))
      : declared.filter((entry) => (opts.probed ? entryVisible(entry, probes) : true));

  for (const entry of candidates) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    visible.push({
      id: entry.id,
      label: entry.label,
      pageId: entry.pageId,
      ...(entry.requiredCapabilityId !== undefined
        ? { requiredCapabilityId: entry.requiredCapabilityId }
        : {}),
      ...(entry.degradedHint !== undefined ? { degradedHint: entry.degradedHint } : {}),
    });
  }
  return visible;
}
