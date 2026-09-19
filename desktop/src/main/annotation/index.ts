import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Annotation } from '@core/entities';
import { ANNOTATION_TARGETS, type AnnotationKind, type AnnotationTarget } from '@core/enums';
import type { AnnotationCreateInput, AnnotationView } from '@core/ipc';
import type { LibraryAnnotation } from '@core/plugins/pluginRuntime/host';
import { findMarkOnSelection } from '@core/annotationMarkList';
import { getDb, schema } from '../db';

/** 宿主认识的标记目标（§6）：只有这些取值才有「跳回去」的导航，其余按包给的标签只读展示。 */
const HOST_TARGETS: ReadonlySet<string> = new Set(ANNOTATION_TARGETS);

function rowToAnnotation(row: typeof schema.annotation.$inferSelect): Annotation {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    kind: row.kind,
    selectedText: row.selectedText,
    noteMd: row.noteMd,
    highlightColor: row.highlightColor,
    selectionStart: row.selectionStart,
    createdAt: row.createdAt,
  };
}

/** 泛型视图：目标类型可能是宿主不认识的取值（包自己起的），一律照原样带出去。 */
function rowToLibraryAnnotation(row: typeof schema.annotation.$inferSelect): LibraryAnnotation {
  return {
    id: row.id,
    targetKind: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel?.trim() || row.targetId,
    kind: row.kind,
    selectedText: row.selectedText,
    noteMd: row.noteMd,
    highlightColor: row.highlightColor,
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

  // 汇总面是跨功能的：宿主认识的取值按目标本身算标签（目标已被删的不进汇总），
  // 包自己起的取值一律进汇总，标签用包存的 target_label，没有就退回原始取值（targetId）。
  // 认不出一个取值不等于把它丢掉——这正是「包内标记也能出现在标记面板」的那条通路。
  return db
    .select()
    .from(schema.annotation)
    .all()
    .filter((a) =>
      HOST_TARGETS.has(a.targetType)
        ? labelByTarget.has(key(a.targetType, a.targetId))
        : true,
    )
    .map((a) => ({
      ...rowToAnnotation(a),
      targetLabel:
        labelByTarget.get(key(a.targetType, a.targetId)) ??
        (a.targetLabel?.trim() || a.targetId),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 包自己起的标记写进汇总面（`library.annotate`）：目标类型与标都由包给，宿主不认识，
 * 原样落库。同一个 `(targetKind, targetId)` 再标一次是**更新**而不是又插一条，
 * 于是「同一个区间重标」与宿主已知目标上的经验一致（见 findDuplicateOnSelection）。
 */
export function createExternalAnnotation(input: {
  targetType: string;
  targetId: string;
  targetLabel?: string;
  kind: string;
  selectedText?: string;
  noteMd?: string;
  highlightColor?: string;
  selectionStart?: number;
}): LibraryAnnotation {
  const db = getDb();
  // 目标类型是包自己起的自由字符串；列上标的类型只是宿主认识的取值，这里按裸 text 比较
  const targetType = input.targetType as AnnotationTarget;
  const existing = db
    .select()
    .from(schema.annotation)
    .where(
      and(
        eq(schema.annotation.targetType, targetType),
        eq(schema.annotation.targetId, input.targetId),
      ),
    )
    .get();

  const now = Date.now();
  const label = input.targetLabel?.trim() || null;

  if (existing) {
    db.update(schema.annotation)
      .set({
        targetLabel: label,
        kind: input.kind as AnnotationKind,
        selectedText: input.selectedText ?? null,
        noteMd: input.noteMd ?? null,
        highlightColor: input.highlightColor ?? null,
        selectionStart: input.selectionStart ?? null,
        createdAt: now,
      })
      .where(eq(schema.annotation.id, existing.id))
      .run();
    return rowToLibraryAnnotation({ ...existing, targetLabel: label, kind: input.kind as AnnotationKind, selectedText: input.selectedText ?? null, noteMd: input.noteMd ?? null, highlightColor: input.highlightColor ?? null, selectionStart: input.selectionStart ?? null, createdAt: now });
  }

  const row = {
    id: randomUUID(),
    targetType,
    targetId: input.targetId,
    targetLabel: label,
    kind: input.kind as AnnotationKind,
    selectedText: input.selectedText ?? null,
    noteMd: input.noteMd ?? null,
    highlightColor: input.highlightColor ?? null,
    selectionStart: input.selectionStart ?? null,
    createdAt: now,
  };
  db.insert(schema.annotation).values(row).run();
  return rowToLibraryAnnotation(row);
}

/** 取回标记（`library.listAnnotations`）：按包自己起的 targetKind 收窄，不传则取全部。 */
export function listExternalAnnotations(query?: {
  targetType?: string;
  limit?: number;
}): LibraryAnnotation[] {
  const rows = getDb().select().from(schema.annotation).all();
  const scoped =
    query?.targetType === undefined
      ? rows
      : rows.filter((row) => row.targetType === query.targetType);
  const limit = Math.max(0, query?.limit ?? 500);
  return scoped
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(rowToLibraryAnnotation);
}

/**
 * 同一段选区上的同类标记只留一条。
 *
 * 界面会先把按钮禁掉，这里是兜底：连点、手机端同时操作、同步回灌都不该攒出重复。
 * 判定规则与两端界面共用 findMarkOnSelection，避免「界面说没有、库里其实有」。
 * 不带选区的整篇笔记（selectedText 为空）不受此限，那本来就是想记几条记几条。
 */
function findDuplicateOnSelection(input: AnnotationCreateInput): Annotation | undefined {
  const selected = input.selectedText?.trim();
  if (!selected) return undefined;
  if (input.kind !== 'highlight' && input.kind !== 'note' && input.kind !== 'elaboration') {
    return undefined;
  }
  return findMarkOnSelection(
    listAnnotations(input.targetType, input.targetId),
    input.kind,
    selected,
    input.selectionStart ?? undefined,
  );
}

export function createAnnotation(input: AnnotationCreateInput): Annotation {
  const duplicate = findDuplicateOnSelection(input);
  if (duplicate) return duplicate;

  const id = randomUUID();
  const now = Date.now();
  const row = {
    id,
    targetType: input.targetType,
    targetId: input.targetId,
    // 宿主自己的目标标签从目标本身算，不落这一列；只有包自起的目标类型才带标签进来
    targetLabel: input.targetLabel ?? null,
    kind: input.kind,
    selectedText: input.selectedText ?? null,
    noteMd: input.noteMd ?? null,
    highlightColor: input.highlightColor ?? null,
    selectionStart: input.selectionStart ?? null,
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
