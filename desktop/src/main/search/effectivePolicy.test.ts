/**
 * 设置页那份「生效中的检索策略」。
 *
 * 钉住的是：域名的岗位专属权重来自岗位包（基础包那张表是空的），而用户显式改过的
 * 值不被岗位包覆盖——否则设置页显示的值与实际检索用的值会分叉。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type AppConfig } from '@core/config';
import type { RolePack } from '@core/plugins/types';

const state = { config: structuredClone(DEFAULT_CONFIG), packs: [] as RolePack[] };

vi.mock('../config', () => ({ getConfig: () => state.config, getSecret: () => null }));
vi.mock('../plugins/runtime', () => ({
  findInstalledRolePack: () => null,
  getCampaignRuntime: () => null,
  listInstalledRolePacks: () => state.packs,
}));
vi.mock('../db', () => ({ getDb: () => null, getRawDb: () => null, schema: {} }));
vi.mock('../llm', () => ({ complete: async () => ({ text: '' }) }));

const { effectiveSearchPolicy } = await import('./index');

function rolePack(overrides: Partial<RolePack> = {}): RolePack {
  return {
    manifest: { id: 'demo-pack', version: '2.0.0', type: 'role-pack' },
    sourcePolicy: {
      preferredDomains: ['nowcoder.com', 'juejin.cn'],
      credibilityOverrides: { 'nowcoder.com': 5 },
    },
    ...overrides,
  } as unknown as RolePack;
}

function setConfig(search: Partial<AppConfig['search']>): void {
  state.config = { ...structuredClone(DEFAULT_CONFIG), search: { ...DEFAULT_CONFIG.search, ...search } };
}

describe('effectiveSearchPolicy', () => {
  it('没装岗位包：没有岗位包那一段，表就是用户自己的', () => {
    state.packs = [];
    setConfig({});

    const policy = effectiveSearchPolicy();

    expect(policy.source).toBeNull();
    expect(policy.domainCredibility).toEqual({});
  });

  it('装了岗位包：包声明的来源进表，并标出是哪个包', () => {
    state.packs = [rolePack()];
    setConfig({});

    const policy = effectiveSearchPolicy();

    expect(policy.source).toEqual({ id: 'demo-pack', version: '2.0.0' });
    expect(policy.domainCredibility).toEqual({ 'nowcoder.com': 5, 'juejin.cn': 3 });
    expect(policy.preferredDomains).toEqual(['juejin.cn', 'nowcoder.com']);
  });

  it('用户显式改过的值不被岗位包覆盖', () => {
    state.packs = [rolePack()];
    setConfig({ domainCredibility: { 'nowcoder.com': 1 } });

    const policy = effectiveSearchPolicy();

    expect(policy.domainCredibility['nowcoder.com']).toBe(1);
  });

  it('岗位包对检索没意见（没声明 sourcePolicy）时不算参与', () => {
    state.packs = [rolePack({ sourcePolicy: undefined })];
    setConfig({});

    expect(effectiveSearchPolicy().source).toBeNull();
  });
});
