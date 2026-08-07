import type { SearchConfig } from '@shared/config';
import type { SearchProviderName } from '@shared/enums';

/** 含 CJK 字符即视作中文查询 */
export function detectLang(query: string): 'zh' | 'en' {
  return /[\u4e00-\u9fff\u3040-\u30ff]/.test(query) ? 'zh' : 'en';
}

function matchesDomainHint(query: string, hints: string[]): boolean {
  const lower = query.toLowerCase();
  return hints.some((hint) => {
    if (hint.includes('*')) {
      const pattern = new RegExp(hint.replace(/\./g, '\\.').replace(/\*/g, '[\\w-]*'), 'i');
      return pattern.test(lower);
    }
    return lower.includes(hint.toLowerCase());
  });
}

/**
 * 按配置的规则顺序匹配，命中即用。
 * 路由自动化是有意的——让用户手动选 provider 只会增加心智负担。
 */
export function pickProvider(query: string, config: SearchConfig): SearchProviderName {
  const lang = detectLang(query);

  for (const rule of config.routing) {
    if (rule.match.lang && rule.match.lang !== lang) continue;
    if (rule.match.domainHint && !matchesDomainHint(query, rule.match.domainHint)) continue;

    const provider = config.providers[rule.provider];
    if (provider.enabled) return rule.provider;
  }

  return config.defaultProvider;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 域名可信度 0-5。未收录的域名给中性的 2 分——
 * 既不因为没见过就拉黑，也不给未知来源过高权重。
 */
export function credibilityOf(domain: string, table: Record<string, number>): number {
  if (!domain) return 1;
  if (domain in table) return table[domain]!;

  // 子域名回落到主域名的评级，如 blog.csdn.net -> csdn.net
  for (const [known, score] of Object.entries(table)) {
    if (domain.endsWith(`.${known}`)) return score;
  }
  return 2;
}
