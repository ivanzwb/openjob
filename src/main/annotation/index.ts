import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Annotation } from '@shared/entities';
import type { AnnotationKind, AnnotationTarget } from '@shared/enums';
import type { AnnotationCreateInput, AnnotationView } from '@shared/ipc';
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

/**
 * 一场面试下的全部标记，覆盖设计里的五类目标：
 * 知识点、讲解片段、代码位置、真题、情报卡。
 *
 * 只按 node 收集是不够的——用户在讲解里划的重点、在真题上记的思路，
 * 复习时同样要能一次性翻出来，否则统一 annotation 表就白建了。
 */
export function listAnnotationsForCampaign(campaignId: string): AnnotationView[] {
  const db = getDb();

  const nodes = db
    .select({ id: schema.knowledgeNode.id, name: schema.knowledgeNode.name })
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();
  const nodeIds = nodes.map((n) => n.id);

  const labelByTarget = new Map<string, string>();
  const key = (type: AnnotationTarget, id: string): string => `${type}|${id}`;

  for (const n of nodes) labelByTarget.set(key('node', n.id), n.name);

  if (nodeIds.length > 0) {
    const nodeNameById = new Map(nodes.map((n) => [n.id, n.name]));
    const explanations = db
      .select({
        id: schema.explanation.id,
        nodeId: schema.explanation.nodeId,
        tier: schema.explanation.tier,
      })
      .from(schema.explanation)
      .where(inArray(schema.explanation.nodeId, nodeIds))
      .all();
    for (const e of explanations) {
      labelByTarget.set(key('explanation', e.id), `${nodeNameById.get(e.nodeId) ?? '讲解'} · ${e.tier}`);
    }
  }

  const questions = db
    .select({
      id: schema.interviewQuestion.id,
      text: schema.interviewQuestion.questionText,
    })
    .from(schema.interviewQuestion)
    .innerJoin(
      schema.interviewReport,
      eq(schema.interviewQuestion.reportId, schema.interviewReport.id),
    )
    .where(eq(schema.interviewReport.campaignId, campaignId))
    .all();
  for (const q of questions) labelByTarget.set(key('question', q.id), q.text.slice(0, 60));

  const intel = db
    .select({ id: schema.companyIntel.id })
    .from(schema.companyIntel)
    .where(eq(schema.companyIntel.campaignId, campaignId))
    .get();
  if (intel) labelByTarget.set(key('intel', intel.id), '公司情报卡');

  if (labelByTarget.size === 0) return [];

  return db
    .select()
    .from(schema.annotation)
    .all()
    .filter((a) => labelByTarget.has(key(a.targetType, a.targetId)))
    .map((a) => ({
      ...rowToAnnotation(a),
      targetLabel: labelByTarget.get(key(a.targetType, a.targetId)) ?? '',
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 一个仓库下的代码位置标记，带出文件与行号供跳转 */
export function listCodeAnnotations(repoId: string): AnnotationView[] {
  const db = getDb();
  const refs = db
    .select()
    .from(schema.codeRef)
    .where(eq(schema.codeRef.repoId, repoId))
    .all();
  if (refs.length === 0) return [];

  const labelById = new Map(refs.map((r) => [r.id, `${r.filePath}:${r.startLine}`]));

  return db
    .select()
    .from(schema.annotation)
    .where(eq(schema.annotation.targetType, 'codeRef'))
    .all()
    .filter((a) => labelById.has(a.targetId))
    .map((a) => ({ ...rowToAnnotation(a), targetLabel: labelById.get(a.targetId) ?? '' }))
    .sort((a, b) => b.createdAt - a.createdAt);
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
