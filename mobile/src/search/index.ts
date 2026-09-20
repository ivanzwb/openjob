import { getMobileConfig, getMobileSecret } from '../config/settings';
import { pickProvider } from '@core/search/routing';
import { bochaSearch } from '@core/search/bocha';
import { DEFAULT_CONFIG } from '@core/config';
import { resolveSearchPolicy } from '@core/search/policy';
import type { RolePack } from '@core/plugins/types';
import type { SearchRequest, SearchResponse } from '@core/ipc';

/**
 * 生效的域名可信度表：core 默认 < 岗位包 sourcePolicy < 用户显式修改（与桌面同一条规则）。
 *
 * 基础包那张表是空的中立表，岗位专属的来源权重在岗位包里——不合并的话，同步过来的
 * 岗位包在这台机器上就等于没有意见，面经站、代码站一律按中性分算。
 * 桌面端按战役取包，手机端的检索没有战役上下文，取本机缓存的那个岗位包（一台设备一个）。
 *
 * 包列表由调用方给，这里不碰数据库：检索是纯逻辑，把 SQLite / react-native 那一整条依赖
 * 拖进来，只会让凡是牵到检索的模块都被它绑住。
 */
export function effectiveCredibility(packs: readonly RolePack[]): Record<string, number> {
  const config = getMobileConfig();
  const pack = packs.find((candidate) => candidate.sourcePolicy);
  return resolveSearchPolicy(
    DEFAULT_CONFIG.search,
    config.search,
    pack?.sourcePolicy
      ? { ...pack.sourcePolicy, id: pack.manifest.id, version: pack.manifest.version }
      : null,
  ).domainCredibility;
}

export async function searchWeb(
  query: string,
  opts?: Pick<SearchRequest, 'freshness' | 'count' | 'cacheCategory'>,
  packs: readonly RolePack[] = [],
): Promise<SearchResponse> {
  const config = getMobileConfig();
  const provider = pickProvider(query, config.search);
  const req: SearchRequest = {
    query,
    freshness: opts?.freshness,
    count: opts?.count ?? 10,
    cacheCategory: opts?.cacheCategory,
  };

  if (provider === 'bocha') {
    const { endpoint, apiKeyRef } = config.search.providers.bocha;
    const apiKey = await getMobileSecret(apiKeyRef);
    if (!apiKey) throw new Error('博查 API Key 未配置，请同步设置');
    const results = await bochaSearch(endpoint, apiKey, req, effectiveCredibility(packs));
    return { provider, query, results, fromCache: false, fetchedAt: Date.now() };
  }

  const { apiKeyRef } = config.search.providers.tavily;
  const apiKey = await getMobileSecret(apiKeyRef);
  if (!apiKey) throw new Error('Tavily API Key 未配置，请同步设置');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.min(req.count ?? 10, 20),
      search_depth: 'basic',
      ...(req.freshness === 'oneYear' ? { days: 365 } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Tavily 搜索失败 HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results = (json.results ?? []).map((r) => ({
    url: r.url ?? '',
    domain: r.url ? new URL(r.url).hostname.replace(/^www\./, '') : '',
    title: r.title ?? r.url ?? '',
    snippet: (r.content ?? '').slice(0, 300),
    contentMd: r.content ?? null,
    publishedAt: null as number | null,
    credibility: 3,
  }));

  return { provider: 'tavily', query, results, fromCache: false, fetchedAt: Date.now() };
}
