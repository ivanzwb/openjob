import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Annotation, Explanation } from '@shared/entities';
import type { AnnotationTarget, ExplanationTier } from '@shared/enums';
import type { AnnotationCreateInput } from '@shared/ipc';
import { findMarkOnSelection } from '@shared/annotationMarkList';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

type ExplanationRow = {
  id: string;
  node_id: string;
  tier: string;
  content_md: string;
  model_used: string;
  source_ids: string;
  created_at: number;
};

type AnnotationRow = {
  id: string;
  target_type: string;
  target_id: string;
  kind: string;
  selected_text: string | null;
  note_md: string | null;
  highlight_color: string | null;
  selection_start: number | null;
  created_at: number;
};

function rowToExplanation(row: ExplanationRow): Explanation {
  let sourceIds: string[] = [];
  try {
    sourceIds = JSON.parse(row.source_ids) as string[];
  } catch {
    sourceIds = [];
  }
  return {
    id: row.id,
    nodeId: row.node_id,
    tier: row.tier as ExplanationTier,
    contentMd: row.content_md,
    modelUsed: row.model_used,
    sourceIds,
    createdAt: row.created_at,
  };
}

function rowToAnnotation(row: AnnotationRow): Annotation {
  return {
    id: row.id,
    targetType: row.target_type as Annotation['targetType'],
    targetId: row.target_id,
    kind: row.kind as Annotation['kind'],
    selectedText: row.selected_text,
    noteMd: row.note_md,
    highlightColor: row.highlight_color,
    selectionStart: row.selection_start,
    createdAt: row.created_at,
  };
}

export function getExplanation(
  db: SQLiteDatabase,
  nodeId: string,
  tier: ExplanationTier,
): Explanation | null {
  const row = db.getFirstSync<ExplanationRow>(
    `SELECT * FROM explanation WHERE node_id = ? AND tier = ?`,
    nodeId,
    tier,
  );
  return row ? rowToExplanation(row) : null;
}

export function listAnnotations(
  db: SQLiteDatabase,
  targetType: AnnotationTarget,
  targetId: string,
): Annotation[] {
  const rows = db.getAllSync<AnnotationRow>(
    `SELECT * FROM annotation WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`,
    targetType,
    targetId,
  );
  return rows.map(rowToAnnotation);
}

/**
 * 同一段选区上的同类标记只留一条，和桌面端 createAnnotation 是同一条规则。
 *
 * 界面会先把按钮禁掉，这里兜住连点；判定复用 findMarkOnSelection，两端结论一致。
 * 不带选区的整篇笔记不受限。
 */
function findDuplicateOnSelection(
  db: SQLiteDatabase,
  input: AnnotationCreateInput,
): Annotation | undefined {
  const selected = input.selectedText?.trim();
  if (!selected) return undefined;
  if (input.kind !== 'highlight' && input.kind !== 'note' && input.kind !== 'elaboration') {
    return undefined;
  }
  return findMarkOnSelection(
    listAnnotations(db, input.targetType, input.targetId),
    input.kind,
    selected,
    input.selectionStart ?? undefined,
  );
}

export async function createAnnotation(
  db: SQLiteDatabase,
  input: AnnotationCreateInput,
): Promise<Annotation> {
  const duplicate = findDuplicateOnSelection(db, input);
  if (duplicate) return duplicate;

  const identity = await getDeviceIdentity(db);
  const id = Crypto.randomUUID();
  const now = Date.now();
  const row: AnnotationRow = {
    id,
    target_type: input.targetType,
    target_id: input.targetId,
    kind: input.kind,
    selected_text: input.selectedText ?? null,
    note_md: input.noteMd ?? null,
    highlight_color: input.highlightColor ?? null,
    selection_start: input.selectionStart ?? null,
    created_at: now,
  };
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO annotation (
        id, target_type, target_id, kind, selected_text, note_md, highlight_color, selection_start, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.target_type,
      row.target_id,
      row.kind,
      row.selected_text,
      row.note_md,
      row.highlight_color,
      row.selection_start,
      row.created_at,
    );
  });
  return rowToAnnotation(row);
}

export async function deleteAnnotation(db: SQLiteDatabase, id: string): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(`DELETE FROM annotation WHERE id = ?`, id);
  });
}

export async function toggleBookmark(
  db: SQLiteDatabase,
  targetType: AnnotationTarget,
  targetId: string,
): Promise<boolean> {
  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM annotation WHERE target_type = ? AND target_id = ? AND kind = 'bookmark'`,
    targetType,
    targetId,
  );
  if (existing) {
    await deleteAnnotation(db, existing.id);
    return false;
  }
  await createAnnotation(db, { targetType, targetId, kind: 'bookmark' });
  return true;
}

export async function updateExplanation(
  db: SQLiteDatabase,
  id: string,
  contentMd: string,
): Promise<Explanation> {
  const trimmed = contentMd.trim();
  if (!trimmed) throw new Error('讲解内容不能为空');

  const row = db.getFirstSync<ExplanationRow>(`SELECT * FROM explanation WHERE id = ?`, id);
  if (!row) throw new Error('讲解不存在');

  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE explanation SET content_md = ?, model_used = 'user-edit', created_at = ? WHERE id = ?`,
      trimmed,
      now,
      id,
    );
  });
  return rowToExplanation({ ...row, content_md: trimmed, model_used: 'user-edit', created_at: now });
}
