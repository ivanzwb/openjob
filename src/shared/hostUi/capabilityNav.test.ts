import { describe, expect, it } from 'vitest';
import { decideCapabilityNavVisible, nextVisibleTab } from './capabilityNav';
import type { CapabilityNavState, CapabilityProbeEntry } from './capabilityNav';

function state(
  entries: CapabilityProbeEntry[],
  overrides: { probed?: boolean; lastKnownVisible?: boolean | null } = {},
): CapabilityNavState {
  return {
    probed: overrides.probed ?? true,
    entries,
    lastKnownVisible: overrides.lastKnownVisible ?? null,
  };
}

describe('decideCapabilityNavVisible', () => {
  it('只要还有一场备考真的能用，入口就留着', () => {
    expect(
      decideCapabilityNavVisible(
        state([
          { campaignId: 'a', mode: 'unsupported' },
          { campaignId: 'b', mode: 'full' },
        ]),
      ),
    ).toBe(true);
  });

  it('所有备考都用不了时隐藏', () => {
    expect(
      decideCapabilityNavVisible(
        state([
          { campaignId: 'a', mode: 'unsupported' },
          { campaignId: 'b', mode: 'unsupported' },
        ]),
      ),
    ).toBe(false);
  });

  /**
   * view-only 是「本机没有 descriptor 固定的那个版本」。源码页做的是克隆、索引、检索，
   * 给一个点进去必然报错的入口，比没有入口更难解释。
   */
  it('只读不算可用', () => {
    expect(decideCapabilityNavVisible(state([{ campaignId: 'a', mode: 'view-only' }]))).toBe(false);
  });

  it('一场备考都没有时保留入口，而不是让用户先猜出要建 Campaign', () => {
    expect(decideCapabilityNavVisible(state([]))).toBe(true);
  });

  it('全是没有 descriptor 的旧 Campaign 时同样保留：这不构成否定证据', () => {
    expect(
      decideCapabilityNavVisible(
        state([
          { campaignId: 'a', mode: null },
          { campaignId: 'b', mode: null },
        ]),
      ),
    ).toBe(true);
  });

  it('有 descriptor 的那些说了算，没有 descriptor 的不参与投票', () => {
    expect(
      decideCapabilityNavVisible(
        state([
          { campaignId: 'a', mode: null },
          { campaignId: 'b', mode: 'unsupported' },
        ]),
      ),
    ).toBe(false);
  });

  /** 探测跑完之前照「不可用」渲染，等 IPC 回来再把入口插回去，是一次肉眼可见的抖动 */
  it('首轮探测没跑完时沿用上次结论', () => {
    expect(decideCapabilityNavVisible(state([], { probed: false, lastKnownVisible: false }))).toBe(
      false,
    );
    expect(decideCapabilityNavVisible(state([], { probed: false, lastKnownVisible: true }))).toBe(
      true,
    );
  });

  it('从来没探测过时默认显示，不因为一次冷启动就吞掉入口', () => {
    expect(decideCapabilityNavVisible(state([], { probed: false }))).toBe(true);
  });

  it('探测完成后结论只由本次结果决定，不再受上次结论影响', () => {
    expect(
      decideCapabilityNavVisible(
        state([{ campaignId: 'a', mode: 'unsupported' }], { lastKnownVisible: true }),
      ),
    ).toBe(false);
  });
});

describe('nextVisibleTab', () => {
  it('当前页签还在就不动用户', () => {
    expect(
      nextVisibleTab<'repos' | 'scripts' | 'campaigns'>(
        'repos',
        (tab) => tab !== 'scripts',
        'campaigns',
      ),
    ).toBe('repos');
  });

  it('当前页签被藏起来时送回兜底页，避免停在一片空白上', () => {
    expect(nextVisibleTab('repos', (tab) => tab !== 'repos', 'campaigns')).toBe('campaigns');
  });
});
