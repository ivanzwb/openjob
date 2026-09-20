/**
 * 手机端的生效可信度表。
 *
 * 基础包那张表是空的中立表，岗位专属的来源权重随岗位包同步过来——不合并的话，
 * 同步到手机的岗位包在检索上等于没有意见。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type AppConfig } from '@core/config';
import type { RolePack } from '@core/plugins/types';

const state = { config: structuredClone(DEFAULT_CONFIG) as AppConfig };

vi.mock('../config/settings', () => ({
  getMobileConfig: () => state.config,
  getMobileSecret: () => Promise.resolve(null),
}));

const { effectiveCredibility } = await import('./index');

function rolePack(overrides: Partial<RolePack> = {}): RolePack {
  return {
    manifest: { id: 'demo-pack', version: '1.0.0', type: 'role-pack' },
    sourcePolicy: {
      preferredDomains: ['nowcoder.com'],
      credibilityOverrides: { 'nowcoder.com': 4 },
      freshnessDays: { companyIntel: 7 },
    },
    ...overrides,
  } as unknown as RolePack;
}

describe('effectiveCredibility', () => {
  it('本机缓存里没有岗位包时就是用户自己那张表', () => {
    state.config = structuredClone(DEFAULT_CONFIG);

    expect(effectiveCredibility([])).toEqual({});
  });

  it('缓存里有岗位包时把它的来源权重合进来', () => {
    state.config = structuredClone(DEFAULT_CONFIG);

    expect(effectiveCredibility([rolePack()])).toEqual({ 'nowcoder.com': 4 });
  });

  it('用户自己改过的权重不被岗位包覆盖', () => {
    state.config = {
      ...structuredClone(DEFAULT_CONFIG),
      search: { ...DEFAULT_CONFIG.search, domainCredibility: { 'nowcoder.com': 1 } },
    };

    expect(effectiveCredibility([rolePack()])['nowcoder.com']).toBe(1);
  });

  it('包对检索没意见时不参与（sourcePolicy 缺失）', () => {
    state.config = structuredClone(DEFAULT_CONFIG);

    expect(effectiveCredibility([rolePack({ sourcePolicy: undefined })])).toEqual({});
  });
});
