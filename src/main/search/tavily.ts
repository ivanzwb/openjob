import type { FetchUrlResponse, SearchRequest, SearchResultItem } from '@shared/ipc';
import { credibilityOf, extractDomain } from './routing';

/**
 * Tavily。用于英文内容：官方文档、GitHub、英文技术博客。
 * 两个能力正好对上设计需求：include/exclude_domains 原生实现域名白黑名单，
 * Extract API 直接充当 fetch_url，无需自写爬虫与正文提取。
 */

const SEARCH_URL = 'https://api.tavily.com/search';
const EXTRACT_URL = 'https://api.tavily.com/extract';

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  published_date?: string;
}

export async function tavilySearch(
  apiKey: string,
  req: SearchRequest,
  credibilityTable: Record<string, number>,
  signal?: AbortSignal,
): Promise<SearchResultItem[]> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: req.query,
      max_results: Math.min(req.count ?? 8, 20),
      // advanced 消耗 2 credit，只在明确需要广度时才开
      search_depth: 'basic',
      include_domains: req.includeDomains ?? undefined,
      exclude_domains: req.excludeDomains ?? undefined,
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Tavily 搜索失败 HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const json = (await res.json()) as { results?: TavilyResult[] };
  return (json.results ?? [])
    .filter((r): r is TavilyResult & { url: string } => Boolean(r.url))
    .map((r) => {
      const domain = extractDomain(r.url);
      return {
        url: r.url,
        domain,
        title: r.title ?? r.url,
        snippet: r.content ?? '',
        contentMd: r.raw_content ?? null,
        publishedAt: r.published_date ? Date.parse(r.published_date) || null : null,
        credibility: credibilityOf(domain, credibilityTable),
      };
    });
}

/** 搜索摘要不够时抓原文，对应共享工具箱里的 fetch_url */
export async function tavilyExtract(
  apiKey: string,
  url: string,
  signal?: AbortSignal,
): Promise<FetchUrlResponse> {
  const res = await fetch(EXTRACT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls: [url], format: 'markdown' }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Tavily 抓取失败 HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const json = (await res.json()) as {
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
  };

  const hit = json.results?.[0];
  if (!hit?.raw_content) {
    const reason = json.failed_results?.[0]?.error ?? '未返回正文';
    throw new Error(`抓取 ${url} 失败: ${reason}`);
  }

  return {
    url: hit.url ?? url,
    title: extractDomain(hit.url ?? url),
    contentMd: hit.raw_content,
    fetchedAt: Date.now(),
  };
}
