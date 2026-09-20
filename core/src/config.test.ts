/**
 * 基础检索默认值的中立性，以及 v1 → v2 的迁移。
 *
 * 钉住的是这一件事：岗位专属的检索策略（哪些域名值多少分、领域知识多久算旧）归岗位包，
 * 基础包不留；而老 config.json 里「恰好等于当初默认值」的那些项要按没动过处理——
 * 否则它们会被认成用户自己的选择，岗位包的策略永远盖不进去。
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  V1_SEARCH_DEFAULTS,
  dropLegacySearchDefaults,
  mergeAppConfig,
} from './config';

describe('基础检索默认值', () => {
  it('基础包对域名可信度没有意见：表是空的', () => {
    expect(DEFAULT_CONFIG.search.domainCredibility).toEqual({});
  });

  it('岗位专属的那几个域名不出现在基础包里', () => {
    for (const domain of Object.keys(V1_SEARCH_DEFAULTS.domainCredibility)) {
      expect(DEFAULT_CONFIG.search.domainCredibility).not.toHaveProperty(domain);
    }
  });

  it('过时阈值是通用口径，不是某个岗位的口径', () => {
    expect(DEFAULT_CONFIG.search.techDocStaleDays).not.toBe(V1_SEARCH_DEFAULTS.techDocStaleDays);
    expect(DEFAULT_CONFIG.search.techDocStaleDays).toBeGreaterThan(0);
  });
});

describe('dropLegacySearchDefaults', () => {
  it('v1 里等于旧默认值的项按没动过处理', () => {
    const migrated = dropLegacySearchDefaults(
      {
        domainCredibility: { ...V1_SEARCH_DEFAULTS.domainCredibility },
        techDocStaleDays: V1_SEARCH_DEFAULTS.techDocStaleDays,
      },
      1,
    );

    expect(migrated?.domainCredibility).toEqual({});
    expect(migrated?.techDocStaleDays).toBeUndefined();
  });

  it('用户改过的值原样保留（哪怕改成了别的数、或自己加的域名）', () => {
    const migrated = dropLegacySearchDefaults(
      {
        domainCredibility: {
          'github.com': 2,
          'csdn.net': 1,
          'my.example': 4,
        },
        techDocStaleDays: 30,
      },
      1,
    );

    expect(migrated?.domainCredibility).toEqual({ 'github.com': 2, 'my.example': 4 });
    expect(migrated?.techDocStaleDays).toBe(30);
  });

  it('缺 version 的配置按 v1 处理，已经到 v2 的配置不动', () => {
    const legacy = dropLegacySearchDefaults({ domainCredibility: { 'csdn.net': 1 } }, undefined);
    expect(legacy?.domainCredibility).toEqual({});

    const current = dropLegacySearchDefaults({ domainCredibility: { 'csdn.net': 1 } }, CONFIG_VERSION);
    expect(current?.domainCredibility).toEqual({ 'csdn.net': 1 });
  });
});

describe('mergeAppConfig', () => {
  it('v1 的配置合并后落到中立默认值，并写成当前版本', () => {
    const merged = mergeAppConfig({
      ...structuredClone(DEFAULT_CONFIG),
      version: 1,
      search: {
        ...structuredClone(DEFAULT_CONFIG.search),
        domainCredibility: { ...V1_SEARCH_DEFAULTS.domainCredibility },
        cacheTtlDays: { companyIntel: 7, interviewReports: 3, techDocs: 30 },
        techDocStaleDays: V1_SEARCH_DEFAULTS.techDocStaleDays,
      },
    });

    expect(merged.version).toBe(CONFIG_VERSION);
    expect(merged.search.domainCredibility).toEqual({});
    expect(merged.search.techDocStaleDays).toBe(DEFAULT_CONFIG.search.techDocStaleDays);
    // 缓存时长岗位包不参与，用户/旧配置里写着的照旧
    expect(merged.search.cacheTtlDays).toEqual({ companyIntel: 7, interviewReports: 3, techDocs: 30 });
  });

  it('没有配置时给的就是中立默认值', () => {
    expect(mergeAppConfig(null).search).toEqual(DEFAULT_CONFIG.search);
  });
});
