/**
 * 插入点 C 的合并引擎：把岗位包的 sourcePolicy 合进检索配置。
 *
 * 覆盖顺序与架构文档 §8.1 一致：core 默认 < 岗位包 < 用户显式修改。
 * 难点是「用户显式修改」无法单独持久化——config.json 里用户没动过的键也写着
 * 默认值。这里的判定是按值比对：某一项的当前值等于 core 默认值视为「未动过」，
 * 岗位包可以补充；只要偏离了默认值就是用户的选择，岗位包不得覆盖。
 *
 * 岗位包对检索的三种意见（SourcePolicy）：
 * - credibilityOverrides：岗位相关域名的可信度（如产品岗给 woshipm.com 加权）；
 * - preferredDomains：岗位建议的来源，未带显式可信度的按 PREFERRED_DOMAIN_CREDIBILITY 计；
 * - freshnessDays：公司情报 / 面经的缓存时长与领域知识的过时门槛。
 */

import type { SearchConfig } from '../config';
import type { SourcePolicy } from '../plugins/types';

export interface EffectiveSearchPolicy {
  /** 合并后的域名可信度表（黑名单 0 照常生效） */
  domainCredibility: Record<string, number>;
  cacheTtlDays: SearchConfig['cacheTtlDays'];
  techDocStaleDays: number;
  /** 岗位包建议的偏好来源，供设置页展示；不含用户自己加的域名 */
  preferredDomains: string[];
  /** 参与合并的岗位包，未挂岗位包时为 null（设置页据此决定展示哪段） */
  source: { id: string; version: string } | null;
}

/** 岗位包偏好来源里未给显式可信度的域名按此计分（与未知域名的中性 2 分区分开） */
export const PREFERRED_DOMAIN_CREDIBILITY = 3;

export function resolveSearchPolicy(
  defaults: SearchConfig,
  effective: SearchConfig,
  pack: (SourcePolicy & { id?: string; version?: string }) | null | undefined,
): EffectiveSearchPolicy {
  const packCredibility = pack?.credibilityOverrides ?? {};
  const preferred = new Set(pack?.preferredDomains ?? []);

  const domains = new Set([
    ...Object.keys(defaults.domainCredibility),
    ...Object.keys(effective.domainCredibility),
    ...Object.keys(packCredibility),
    ...preferred,
  ]);

  const domainCredibility: Record<string, number> = {};
  for (const domain of domains) {
    const userValue = effective.domainCredibility[domain];
    const defaultValue = defaults.domainCredibility[domain];
    const userTouched = userValue !== undefined && userValue !== defaultValue;
    const packValue = packCredibility[domain];

    if (userTouched) {
      domainCredibility[domain] = userValue;
    } else if (packValue !== undefined) {
      domainCredibility[domain] = packValue;
    } else if (userValue !== undefined) {
      domainCredibility[domain] = userValue;
    } else if (preferred.has(domain)) {
      domainCredibility[domain] = PREFERRED_DOMAIN_CREDIBILITY;
    }
  }

  const packFreshness = pack?.freshnessDays ?? {};
  const cacheTtlDays: SearchConfig['cacheTtlDays'] = {
    companyIntel: pickRefined(
      defaults.cacheTtlDays.companyIntel,
      effective.cacheTtlDays.companyIntel,
      packFreshness.companyIntel,
    ),
    interviewReports: pickRefined(
      defaults.cacheTtlDays.interviewReports,
      effective.cacheTtlDays.interviewReports,
      packFreshness.interviewReports,
    ),
    // 岗位包对 techDocs 缓存没有意见，保持用户当前值
    techDocs: effective.cacheTtlDays.techDocs,
  };

  return {
    domainCredibility,
    cacheTtlDays,
    techDocStaleDays: pickRefined(
      defaults.techDocStaleDays,
      effective.techDocStaleDays,
      packFreshness.domainKnowledge,
    ),
    preferredDomains: [...preferred].sort(),
    source: pack?.id && pack?.version ? { id: pack.id, version: pack.version } : null,
  };
}

/** 未动过默认值且岗位包有意见时采纳岗位包，否则保持当前值 */
function pickRefined(defaultValue: number, effectiveValue: number, packValue?: number): number {
  if (effectiveValue !== defaultValue) return effectiveValue;
  return packValue ?? effectiveValue;
}
