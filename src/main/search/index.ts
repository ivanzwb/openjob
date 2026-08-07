import { randomUUID } from 'node:crypto';
import type {
  FetchUrlRequest,
  FetchUrlResponse,
  SearchRequest,
  SearchResponse,
  SearchResultItem,
} from '@shared/ipc';
import { getConfig, getSecret } from '../config';
import { getDb, schema } from '../db';
import { bochaSearch } from './bocha';
import { tavilyExtract, tavilySearch } from './tavily';
import { pickProvider } from './routing';

export { detectLang, extractDomain, credibilityOf, pickProvider } from './routing';
export { clearCache } from './cache';

import { readCache, writeCache } from './cache';

function requireKey(ref: string, label: string): string {
  const key = getSecret(ref);
  if (!key) throw new Error(`${label} 未配置 API Key，请在设置中填写`);
  return key;
}

/** 检索结果落库成 source，供后续引用追溯 */
function persistSources(items: SearchResultItem[], provider: string): void {
  const db = getDb();
  const now = Date.now();
  for (const item of items) {
    db.insert(schema.source)
      .values({
        id: randomUUID(),
        url: item.url,
        domain: item.domain,
        title: item.title,
        provider: provider as 'bocha' | 'tavily',
        credibility: item.credibility,
        publishedAt: item.publishedAt,
        fetchedAt: now,
        contentMd: item.contentMd,
      })
      .run();
  }
}

export async function search(req: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  const config = getConfig();
  const provider = req.provider ?? pickProvider(req.query, config.search);

  const cached = readCache(provider, req);
  if (cached) {
    return {
      provider,
      query: req.query,
      results: cached.results,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
    };
  }

  const table = config.search.domainCredibility;
  let results: SearchResultItem[];

  if (provider === 'bocha') {
    const { endpoint, apiKeyRef } = config.search.providers.bocha;
    results = await bochaSearch(endpoint, requireKey(apiKeyRef, '博查'), req, table, signal);
  } else {
    const { apiKeyRef } = config.search.providers.tavily;
    results = await tavilySearch(requireKey(apiKeyRef, 'Tavily'), req, table, signal);
  }

  // 可信度 0 是黑名单，永远丢弃；调用方可通过 minCredibility 收得更紧
  const floor = Math.max(req.minCredibility ?? 1, 1);
  results = results.filter((r) => r.credibility >= floor);
  // 高可信度来源排在前面，进上下文时优先被采纳
  results.sort((a, b) => b.credibility - a.credibility);

  const ttl = config.search.cacheTtlDays[req.cacheCategory ?? 'techDocs'];
  writeCache(provider, req, results, ttl);
  persistSources(results, provider);

  return { provider, query: req.query, results, fromCache: false, fetchedAt: Date.now() };
}

export async function fetchUrl(
  req: FetchUrlRequest,
  signal?: AbortSignal,
): Promise<FetchUrlResponse> {
  const config = getConfig();
  const { apiKeyRef } = config.search.providers.tavily;
  return tavilyExtract(requireKey(apiKeyRef, 'Tavily'), req.url, signal);
}
