import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DEFAULT_CONFIG } from '@core/config';
import type {
  FetchUrlRequest,
  FetchUrlResponse,
  SearchRequest,
  SearchResponse,
  SearchResultItem,
} from '@core/ipc';
import type { SourcePolicy } from '@core/plugins/types';
import { resolveSearchPolicy, type EffectiveSearchPolicy } from '@core/search/policy';
import { getConfig, getSecret } from '../config';
import { getDb, getRawDb, schema } from '../db';
import { findInstalledRolePack, getCampaignRuntime } from '../plugins/runtime';
import { bochaSearch } from './bocha';
import { tavilyExtract, tavilySearch } from './tavily';
import { credibilityOf, extractDomain, pickProvider } from './routing';
import { annotateFreshness } from './freshness';
import { readCache, writeCache } from './cache';

export { detectLang, extractDomain, credibilityOf, pickProvider } from './routing';
export { freshnessLabel } from './freshness';
export { clearCache } from './cache';

function requireKey(ref: string, label: string): string {
  const key = getSecret(ref);
  if (!key) throw new Error(`${label} 未配置 API Key，请在设置中填写`);
  return key;
}

/**
 * 取 Campaign 岗位包的检索策略（插入点 C）。
 *
 * 解析失败不阻断检索：descriptor 缺失（旧数据没回填）、岗位包被卸载，都退回
 * 全局配置——检索是诊断和 Agent 工具的依赖项，不能因为策略层缺席而不可用。
 */
function resolvePackSourcePolicy(campaignId?: string): SourcePolicy | null {
  if (!campaignId) return null;
  try {
    const view = getCampaignRuntime(getRawDb(), campaignId);
    if (!view) return null;
    const { id, version } = view.descriptor.rolePack;
    return findInstalledRolePack(id, version)?.sourcePolicy ?? null;
  } catch {
    return null;
  }
}

/**
 * 检索结果落库成 source，供后续引用追溯。
 * 同一 URL 复用已有行并刷新抓取时间，否则反复检索会堆出大量重复记录，
 * 面经也就没法稳定指回某一条出处。
 */
function persistSources(items: SearchResultItem[], provider: string): void {
  const db = getDb();
  const now = Date.now();

  for (const item of items) {
    const existing = db
      .select({ id: schema.source.id, contentMd: schema.source.contentMd })
      .from(schema.source)
      .where(eq(schema.source.url, item.url))
      .get();

    if (existing) {
      db.update(schema.source)
        .set({
          title: item.title,
          credibility: item.credibility,
          publishedAt: item.publishedAt,
          fetchedAt: now,
          // 已抓到正文的不要被摘要覆盖
          contentMd: item.contentMd ?? existing.contentMd,
        })
        .where(eq(schema.source.id, existing.id))
        .run();
      item.sourceId = existing.id;
      continue;
    }

    const id = randomUUID();
    db.insert(schema.source)
      .values({
        id,
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
    item.sourceId = id;
  }
}

export async function search(req: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  const config = getConfig();
  // 插入点 C：core 默认 < 岗位包 sourcePolicy < 用户显式修改（policy.ts 按值比对判定）
  const policy: EffectiveSearchPolicy = resolveSearchPolicy(
    DEFAULT_CONFIG.search,
    config.search,
    resolvePackSourcePolicy(req.campaignId),
  );
  const provider = req.provider ?? pickProvider(req.query, config.search);

  const cached = readCache(provider, req);
  if (cached) {
    return {
      provider,
      query: req.query,
      // 缓存里存的年龄是写入时算的，重新算一遍才不会越读越旧
      results: annotateFreshness(cached.results, req.cacheCategory, policy.techDocStaleDays),
      fromCache: true,
      fetchedAt: cached.fetchedAt,
    };
  }

  const table = policy.domainCredibility;
  let results: SearchResultItem[];

  if (provider === 'bocha') {
    const { endpoint, apiKeyRef } = config.search.providers.bocha;
    results = await bochaSearch(endpoint, requireKey(apiKeyRef, '博查'), req, table, signal);
  } else {
    const { apiKeyRef, country } = config.search.providers.tavily;
    results = await tavilySearch(
      requireKey(apiKeyRef, 'Tavily'),
      req,
      table,
      req.country ?? country,
      signal,
    );
  }

  // 可信度 0 是黑名单，永远丢弃；调用方可通过 minCredibility 收得更紧
  const floor = Math.max(req.minCredibility ?? 1, 1);
  results = results.filter((r) => r.credibility >= floor);
  // 高可信度来源排在前面，进上下文时优先被采纳
  results.sort((a, b) => b.credibility - a.credibility);
  // 再把过时的技术文档整体压到后面，可信度顺序在组内保持不变
  results = annotateFreshness(results, req.cacheCategory, policy.techDocStaleDays);

  // 先落 source 再写缓存，缓存里的结果才带得上 sourceId
  persistSources(results, provider);
  const ttl = policy.cacheTtlDays[req.cacheCategory ?? 'techDocs'];
  writeCache(provider, req, results, ttl);

  return { provider, query: req.query, results, fromCache: false, fetchedAt: Date.now() };
}

export async function fetchUrl(
  req: FetchUrlRequest,
  signal?: AbortSignal,
): Promise<FetchUrlResponse> {
  const config = getConfig();
  const { apiKeyRef } = config.search.providers.tavily;
  const res = await tavilyExtract(requireKey(apiKeyRef, 'Tavily'), req.url, signal);

  const db = getDb();
  const existing = db
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(eq(schema.source.url, res.url))
    .get();

  if (existing) {
    db.update(schema.source)
      .set({ contentMd: res.contentMd, fetchedAt: res.fetchedAt })
      .where(eq(schema.source.id, existing.id))
      .run();
    return { ...res, sourceId: existing.id };
  }

  const domain = extractDomain(res.url);
  const id = randomUUID();
  db.insert(schema.source)
    .values({
      id,
      url: res.url,
      domain,
      title: res.title,
      provider: 'tavily',
        credibility: credibilityOf(domain, config.search.domainCredibility),
      publishedAt: null,
      fetchedAt: res.fetchedAt,
      contentMd: res.contentMd,
    })
    .run();

  return { ...res, sourceId: id };
}
