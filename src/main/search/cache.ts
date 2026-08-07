import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SearchRequest, SearchResultItem } from '@shared/ipc';
import type { SearchProviderName } from '@shared/enums';
import { getDb, schema } from '../db';

/**
 * 搜索结果缓存。真正贵的不是搜索调用本身，而是把抓回的正文塞进上下文，
 * 但缓存同样能省下重复检索的延迟——同一家公司的面经没必要每次重搜。
 */

function hashOf(provider: SearchProviderName, req: SearchRequest): string {
  const normalized = {
    provider,
    query: req.query.trim().toLowerCase(),
    freshness: req.freshness ?? 'noLimit',
    count: req.count ?? null,
    includeDomains: req.includeDomains ?? null,
    excludeDomains: req.excludeDomains ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function readCache(
  provider: SearchProviderName,
  req: SearchRequest,
): { results: SearchResultItem[]; fetchedAt: number } | null {
  if (req.noCache) return null;

  const db = getDb();
  const hash = hashOf(provider, req);
  const row = db
    .select()
    .from(schema.searchCache)
    .where(and(eq(schema.searchCache.queryHash, hash), eq(schema.searchCache.provider, provider)))
    .get();

  if (!row) return null;

  const expiresAt = row.fetchedAt + row.ttlDays * 24 * 60 * 60 * 1000;
  if (Date.now() > expiresAt) {
    db.delete(schema.searchCache).where(eq(schema.searchCache.id, row.id)).run();
    return null;
  }

  return { results: row.resultsJson as SearchResultItem[], fetchedAt: row.fetchedAt };
}

export function writeCache(
  provider: SearchProviderName,
  req: SearchRequest,
  results: SearchResultItem[],
  ttlDays: number,
): void {
  const db = getDb();
  const hash = hashOf(provider, req);

  db.delete(schema.searchCache)
    .where(and(eq(schema.searchCache.queryHash, hash), eq(schema.searchCache.provider, provider)))
    .run();

  db.insert(schema.searchCache)
    .values({
      id: randomUUID(),
      queryHash: hash,
      provider,
      paramsJson: { query: req.query, freshness: req.freshness ?? 'noLimit' },
      resultsJson: results,
      fetchedAt: Date.now(),
      ttlDays,
    })
    .run();
}

export function clearCache(): number {
  const db = getDb();
  const before = db.select().from(schema.searchCache).all().length;
  db.delete(schema.searchCache).run();
  return before;
}
