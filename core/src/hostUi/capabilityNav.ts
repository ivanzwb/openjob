/**
 * 全局导航项的能力门控。
 *
 * 这里要解决的是一处真实的粒度错配：「源码」是应用级导航，而
 * `campaign:getClientCapabilityView` 是按 Campaign 算的——同一台机器上，A 岗位启用了
 * source-repository，B 岗位没有。没有「当前 Campaign」这个全局概念的地方（顶部导航
 * 就是其中之一），只能对所有 Campaign 求一次并集：只要还有一场备考真的能用这项能力，
 * 入口就得留着，否则用户会在 A 岗位里找不到刚刚还在用的源码页。
 *
 * 另外两条约束写进类型里，而不是留给调用方自觉：
 *
 * 1. 探测没跑完之前不能给结论。首帧就照「不可用」渲染，等 IPC 回来再把入口插回去，
 *    是一次肉眼可见的抖动；所以未探测时用上一次的结论兜底。
 * 2. 「一个 Campaign 都没有」和「所有 Campaign 都不支持」是两件事。新装的应用里没有
 *    任何 descriptor 能说这项能力不可用，此时把入口藏起来等于让用户先猜出「要先建
 *    Campaign 才会长出源码页」。
 */

import type { ClientCapabilityMode } from '../plugins/clientView';

export interface CapabilityProbeEntry {
  campaignId: string;
  /** null 表示该 Campaign 还没有 descriptor（旧库未回填或尚未激活），不构成否定证据 */
  mode: ClientCapabilityMode | null;
}

export interface CapabilityNavState {
  /** 首轮探测是否已经完成 */
  probed: boolean;
  entries: readonly CapabilityProbeEntry[];
  /** 上一次探测得到的结论；首次启动时为 null */
  lastKnownVisible: boolean | null;
}

/**
 * 能执行才算「可用」。
 *
 * view-only 意味着本机没有 descriptor 固定的那个版本，只能看历史结果；而源码页做的是
 * 克隆、索引、检索这类执行动作，给一个点进去只会报错的入口比不给更糟。
 */
function usable(mode: ClientCapabilityMode | null): boolean {
  return mode === 'full';
}

export function decideCapabilityNavVisible(state: CapabilityNavState): boolean {
  if (!state.probed) return state.lastKnownVisible ?? true;

  const known = state.entries.filter((entry) => entry.mode !== null);
  if (known.length === 0) return true;
  return known.some((entry) => usable(entry.mode));
}

/**
 * 隐藏当前所在的页签时把用户送到别处。
 *
 * 门控是异步算出来的，用户完全可能正停在「源码」上：留在一个已经不渲染的页签里，
 * 界面就是一片空白，而导航栏上又没有任何一项是选中态。
 */
export function nextVisibleTab<T extends string>(
  current: T,
  isVisible: (tab: T) => boolean,
  fallback: T,
): T {
  return isVisible(current) ? current : fallback;
}
