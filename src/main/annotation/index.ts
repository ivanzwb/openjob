import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Annotation } from '@shared/entities';
import type { AnnotationKind, AnnotationTarget } from '@shared/enums';
import type { AnnotationCreateInput } from '@shared/ipc';
import { getDb, schema } from '../db';

function rowToAnnotation(row: typeof schema.annotation.$inferSelect): Annotation {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    kind: row.kind,
    selectedText: row.selectedText,
    noteMd: row.noteMd,
    createdAt: row.createdAt,
  };
}

export function listAnnotations(
  targetType: AnnotationTarget,
  targetId: string,
): Annotation[] {
  return getDb()
    .select()
    .from(schema.annotation)
    .where(
      and(
        eq(schema.annotation.targetType, targetType),
        eq(schema.annotation.targetId, targetId),
      ),
    )
    .all()
    .map(rowToAnnotation)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function listAnnotationsForCampaign(campaignId: string): Annotation[] {
  const db = getDb();
  const nodeIds = db
    .select({ id: schema.knowledgeNode.id })
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all()
    .map((n) => n.id);

  if (nodeIds.length === 0) return [];

  const all = db.select().from(schema.annotation).all();
  const idSet = new Set(nodeIds);
  return all
    .filter((a) => a.targetType === 'node' && idSet.has(a.targetId))
    .map(rowToAnnotation);
}

export function createAnnotation(input: AnnotationCreateInput): Annotation {
  const id = randomUUID();
  const now = Date.now();
  const row = {
    id,
    targetType: input.targetType,
    targetId: input.targetId,
    kind: input.kind,
    selectedText: input.selectedText ?? null,
    noteMd: input.noteMd ?? null,
    createdAt: now,
  };
  getDb().insert(schema.annotation).values(row).run();
  return rowToAnnotation(row);
}

export function deleteAnnotation(id: string): void {
  getDb().delete(schema.annotation).where(eq(schema.annotation.id, id)).run();
}

export function toggleBookmark(targetType: AnnotationTarget, targetId: string): boolean {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.annotation)
    .where(
      and(
        eq(schema.annotation.targetType, targetType),
        eq(schema.annotation.targetId, targetId),
        eq(schema.annotation.kind, 'bookmark'),
      ),
    )
    .get();

  if (existing) {
    db.delete(schema.annotation).where(eq(schema.annotation.id, existing.id)).run();
    return false;
  }

  createAnnotation({ targetType, targetId, kind: 'bookmark' });
  return true;
}

export function isBookmarked(
  annotations: Annotation[],
  targetId: string,
  kind: AnnotationKind = 'bookmark',
): boolean {
  return annotations.some((a) => a.targetId === targetId && a.kind === kind);
}
