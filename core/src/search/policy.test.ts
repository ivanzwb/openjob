import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import type { SourcePolicy } from '../plugins/types';
import { PREFERRED_DOMAIN_CREDIBILITY, resolveSearchPolicy } from './policy';

const defaults = DEFAULT_CONFIG.search;

function effective(overrides: Partial<typeof defaults> = {}): typeof defaults {
  return structuredClone({ ...defaults, ...overrides });
}

function pack(policy: Partial<SourcePolicy>): SourcePolicy & { id: string; version: string } {
  return {
    id: 'product-manager',
    version: '1.2.0',
    preferredDomains: [],
    ...policy,
  };
}

describe('resolveSearchPolicy', () => {
  it('没有岗位包时等于当前配置', () => {
    const user = effective({
      domainCredibility: { ...defaults.domainCredibility, 'zhihu.com': 4 },
    });
    const policy = resolveSearchPolicy(defaults, user, null);

    expect(policy.domainCredibility).toEqual(user.domainCredibility);
    expect(policy.techDocStaleDays).toBe(defaults.techDocStaleDays);
    expect(policy.source).toBeNull();
    expect(policy.preferredDomains).toEqual([]);
  });

  it('岗位包为配置里没有的岗位域名补充可信度（产品岗示例）', () => {
    const policy = resolveSearchPolicy(defaults, effective(), pack({
      preferredDomains: ['woshipm.com', 'pmcaff.com'],
      credibilityOverrides: { 'svpg.com': 5 },
    }));

    expect(policy.domainCredibility['svpg.com']).toBe(5);
    expect(policy.domainCredibility['woshipm.com']).toBe(PREFERRED_DOMAIN_CREDIBILITY);
    // 工程域名的默认值不受影响
    expect(policy.domainCredibility['github.com']).toBe(defaults.domainCredibility['github.com']);
    expect(policy.preferredDomains).toEqual(['pmcaff.com', 'woshipm.com']);
    expect(policy.source).toEqual({ id: 'product-manager', version: '1.2.0' });
  });

  it('用户改过的域名不被岗位包覆盖，没动过的可以被覆盖', () => {
    const user = effective({
      // 用户把 csdn.net 调到 4（默认 1）：显式选择
      domainCredibility: { ...defaults.domainCredibility, 'csdn.net': 4 },
    });
    const policy = resolveSearchPolicy(defaults, user, pack({
      credibilityOverrides: { 'csdn.net': 0, 'juejin.cn': 5 },
    }));

    expect(policy.domainCredibility['csdn.net']).toBe(4);
    expect(policy.domainCredibility['juejin.cn']).toBe(5);
  });

  it('偏好来源给不了黑名单：用户拉黑的域名保持 0', () => {
    const user = effective({
      domainCredibility: { ...defaults.domainCredibility, 'spam.example': 0 },
    });
    const policy = resolveSearchPolicy(defaults, user, pack({
      preferredDomains: ['spam.example'],
    }));

    expect(policy.domainCredibility['spam.example']).toBe(0);
  });

  it('未动过的时效默认值可以被岗位包细化，动过的保持用户值', () => {
    const untouched = resolveSearchPolicy(defaults, effective(), pack({
      freshnessDays: { companyIntel: 3, interviewReports: 2, domainKnowledge: 730 },
    }));
    expect(untouched.cacheTtlDays.companyIntel).toBe(3);
    expect(untouched.cacheTtlDays.interviewReports).toBe(2);
    expect(untouched.techDocStaleDays).toBe(730);
    expect(untouched.cacheTtlDays.techDocs).toBe(defaults.cacheTtlDays.techDocs);

    const tuned = resolveSearchPolicy(
      defaults,
      effective({
        cacheTtlDays: { ...defaults.cacheTtlDays, companyIntel: 1 },
        techDocStaleDays: 90,
      }),
      pack({ freshnessDays: { companyIntel: 3, domainKnowledge: 730 } }),
    );
    expect(tuned.cacheTtlDays.companyIntel).toBe(1);
    expect(tuned.techDocStaleDays).toBe(90);
  });
});
