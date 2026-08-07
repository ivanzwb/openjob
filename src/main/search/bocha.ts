import type { SearchRequest, SearchResultItem } from '@shared/ipc';
import { credibilityOf, extractDomain } from './routing';

/**
 * 博查 Web Search。中文内容与国内技术社区覆盖优于 Tavily，
 * 且原生支持 freshness 时效过滤——面经检索应传 oneYear。
 */

interface BochaWebPage {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  datePublished?: string;
  dateLastCrawled?: string;
}

interface BochaResponse {
  code?: number;
  msg?: string;
  data?: {
    webPages?: { value?: BochaWebPage[] };
  };
}

export async function bochaSearch(
  endpoint: string,
  apiKey: string,
  req: SearchRequest,
  credibilityTable: Record<string, number>,
  signal?: AbortSignal,
): Promise<SearchResultItem[]> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: req.query,
      freshness: req.freshness ?? 'noLimit',
      summary: true,
      count: Math.min(req.count ?? 10, 50),
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`博查搜索失败 HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const json = (await res.json()) as BochaResponse;
  if (json.code !== undefined && json.code !== 200) {
    throw new Error(`博查搜索失败: ${json.msg ?? `code ${json.code}`}`);
  }

  const pages = json.data?.webPages?.value ?? [];
  return pages
    .filter((p): p is BochaWebPage & { url: string } => Boolean(p.url))
    .map((p) => {
      const domain = extractDomain(p.url);
      return {
        url: p.url,
        domain,
        title: p.name ?? p.url,
        snippet: p.snippet ?? '',
        // summary 是博查返回的正文摘要，比 snippet 信息量大
        contentMd: p.summary ?? null,
        publishedAt: p.datePublished ? Date.parse(p.datePublished) || null : null,
        credibility: credibilityOf(domain, credibilityTable),
      };
    });
}
