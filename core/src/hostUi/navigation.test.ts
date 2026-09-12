import { describe, expect, it } from 'vitest';
import type { NavigationEntry } from '../plugins/types';
import { entryVisible, resolveVisibleNavigation, type NavigationProbe } from './navigation';

const sourceEntry: NavigationEntry = {
  id: 'se.source-repository',
  label: '源码',
  pageId: 'source-repository',
  requiredCapabilityId: 'openjob-capabilities',
};

function probe(fullCapabilityIds: string[] | null): NavigationProbe {
  return { campaignId: fullCapabilityIds === null ? 'legacy' : `c-${fullCapabilityIds.join()}`, fullCapabilityIds };
}

describe('entryVisible', () => {
  it('没有任何 descriptor 时入口可见：不构成否定证据', () => {
    expect(entryVisible(sourceEntry, [])).toBe(true);
    expect(entryVisible(sourceEntry, [probe(null)])).toBe(true);
  });

  it('任一 Campaign 启用对应能力即可见（跨 Campaign 并集）', () => {
    expect(
      entryVisible(sourceEntry, [probe([]), probe(['openjob-capabilities'])]),
    ).toBe(true);
  });

  it('所有已知 Campaign 都未启用时不可见；descriptor 缺失不算否定', () => {
    expect(entryVisible(sourceEntry, [probe([])])).toBe(false);
    expect(entryVisible(sourceEntry, [probe([]), probe(null)])).toBe(false);
  });

  it('不依赖能力的入口始终可见', () => {
    const free: NavigationEntry = { ...sourceEntry, requiredCapabilityId: undefined };
    expect(entryVisible(free, [probe([])])).toBe(true);
  });
});

describe('resolveVisibleNavigation', () => {
  const declared: NavigationEntry[] = [
    sourceEntry,
    { id: 'pm.some-page', label: '产品页', pageId: 'source-repository', requiredCapabilityId: 'pm-pack' },
  ];

  it('按声明顺序输出去重后的入口', () => {
    const resolved = resolveVisibleNavigation(
      [sourceEntry, { ...sourceEntry, label: '重复' }],
      [probe(['openjob-capabilities'])],
      { probed: true, lastKnownIds: null },
    );
    expect(resolved.map((entry) => entry.id)).toEqual(['se.source-repository']);
    expect(resolved[0]).toMatchObject({ label: '源码', pageId: 'source-repository' });
  });

  it('probed=false 时按上次结论过滤，无历史结论时全部可见', () => {
    const lastKnown = resolveVisibleNavigation(declared, [], {
      probed: false,
      lastKnownIds: ['pm.some-page'],
    });
    expect(lastKnown.map((entry) => entry.id)).toEqual(['pm.some-page']);

    const noHistory = resolveVisibleNavigation(declared, [], {
      probed: false,
      lastKnownIds: null,
    });
    expect(noHistory.map((entry) => entry.id)).toEqual(['se.source-repository', 'pm.some-page']);
  });

  it('probed 后按各入口的能力启用情况过滤', () => {
    const resolved = resolveVisibleNavigation(
      declared,
      [probe(['openjob-capabilities'])],
      { probed: true, lastKnownIds: null },
    );
    expect(resolved.map((entry) => entry.id)).toEqual(['se.source-repository']);
  });

  it('多入口同 id 只保留第一个声明，不被后面的岗位包替换', () => {
    const resolved = resolveVisibleNavigation(
      declared,
      [probe(['openjob-capabilities', 'pm-pack'])],
      { probed: true, lastKnownIds: null },
    );
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.label).toBe('源码');
  });
});
