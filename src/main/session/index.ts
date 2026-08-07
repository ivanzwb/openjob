import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Citation } from '@shared/entities';
import type { SessionKind } from '@shared/enums';
import type { SessionMessageView, SessionSummary } from '@shared/ipc';
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
