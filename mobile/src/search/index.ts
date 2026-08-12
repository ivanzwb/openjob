import { getMobileConfig, getMobileSecret } from '../config/settings';
import { pickProvider } from '@shared/search/routing';
import { bochaSearch } from '@shared/search/bocha';
import type { SearchRequest, SearchResponse } from '@shared/ipc';

export async function searchWeb(
  query: string,
  opts?: Pick<SearchRequest, 'freshness' | 'count' | 'cacheCategory'>,
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
    const results = await bochaSearch(
      endpoint,
      apiKey,
      req,
      config.search.domainCredibility,
    );
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
    results?: Array<{ title?: string; url?: string; content?: string }>;
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
