import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Citation } from '@shared/entities';
import type { SessionKind } from '@shared/enums';
import type { SessionMessageView, SessionSearchHit, SessionSummary } from '@shared/ipc';
import { getDb, schema } from '../db';

export function createSession(
  kind: SessionKind,
  title: string,
  campaignId?: string | null,
): string {
  const id = randomUUID();
  getDb()
    .insert(schema.session)
    .values({
      id,
      campaignId: campaignId ?? null,
      kind,
      title: title.slice(0, 120),
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  contentMd: string,
  citations: Citation[] = [],
): string {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .insert(schema.message)
    .values({
      id,
      sessionId,
      role,
      contentMd,
      citations,
      createdAt: now,
    })
    .run();
  return id;
}

export function appendToolCall(
  messageId: string,
  toolName: string,
  args: Record<string, unknown>,
  resultSummary: string,
  durationMs: number,
): void {
  getDb()
    .insert(schema.toolCall)
    .values({
      id: randomUUID(),
      messageId,
      toolName: toolName as (typeof schema.toolCall.$inferInsert)['toolName'],
      args,
      resultSummary,
      durationMs,
      tokenCost: null,
      createdAt: Date.now(),
    })
    .run();
}

export function listSessions(kind?: SessionKind, limit = 50): SessionSummary[] {
  const rows = getDb()
    .select()
    .from(schema.session)
    .orderBy(desc(schema.session.createdAt))
    .all()
    .filter((s) => (kind ? s.kind === kind : true))
    .slice(0, limit);

  const db = getDb();
  return rows.map((s) => {
    const msgCount =
      db
        .select()
        .from(schema.message)
        .where(eq(schema.message.sessionId, s.id))
        .all().length;
    return {
      id: s.id,
      campaignId: s.campaignId,
      kind: s.kind,
      title: s.title,
      createdAt: s.createdAt,
      messageCount: msgCount,
    };
  });
}

/**
 * 全文搜索会话。命中标题或任意一条消息都算，返回命中片段供定位。
 *
 * 用 LIKE 而非 FTS5：会话量级是几百条，够用；
 * 引入 FTS 虚拟表会让 schema 迁移复杂度陡增，不值当。
 */
export function searchSessions(query: string, limit = 30): SessionSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const db = getDb();
  const sessions = db
    .select()
    .from(schema.session)
    .orderBy(desc(schema.session.createdAt))
    .all();
  if (sessions.length === 0) return [];

  const messages = db.select().from(schema.message).all();
  const bySession = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = bySession.get(m.sessionId) ?? [];
    list.push(m);
    bySession.set(m.sessionId, list);
  }

  const hits: SessionSearchHit[] = [];
  for (const s of sessions) {
    const msgs = bySession.get(s.id) ?? [];
    const titleHit = s.title.toLowerCase().includes(q);
    const matched = msgs.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.contentMd.toLowerCase().includes(q),
    );
    if (!titleHit && matched.length === 0) continue;

    const first = matched[0];
    hits.push({
      id: s.id,
      campaignId: s.campaignId,
      kind: s.kind,
      title: s.title,
      createdAt: s.createdAt,
      messageCount: msgs.length,
      matchCount: matched.length,
      snippet: first ? excerpt(first.contentMd, q) : s.title,
    });
    if (hits.length >= limit) break;
  }

  return hits;
}

/** 截出命中词前后各 60 字，让用户一眼看出为什么这条被搜到 */
function excerpt(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle);
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + needle.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

export function deleteSession(sessionId: string): void {
  getDb().delete(schema.session).where(eq(schema.session.id, sessionId)).run();
}

export function getSessionMessages(sessionId: string): SessionMessageView[] {
  return getDb()
    .select()
    .from(schema.message)
    .where(eq(schema.message.sessionId, sessionId))
    .orderBy(schema.message.createdAt)
    .all()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role as 'user' | 'assistant',
      contentMd: m.contentMd,
      citations: m.citations,
      createdAt: m.createdAt,
    }));
}
