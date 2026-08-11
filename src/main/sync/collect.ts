import type { Database } from 'better-sqlite3';
import type { ChangeSet, RowSnapshot, Tombstone } from '@shared/sync';
import { syncTableSpec, syncTableSpecs } from './tables';

interface OplogRow {
  seq: number;
  table_name: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
  wall_ms: number;
  changed_fields: string | null;
}

interface RowGroup {
  table: string;
  rowId: string;
  ops: OplogRow[];
}

function parseChangedFields(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function readRow(
  raw: Database,
  table: string,
  rowId: string,
): Record<string, unknown> | null {
  const spec = syncTableSpec(table);
  const cols = spec.columns.map((c) => `\`${c}\``).join(', ');
  const row = raw
    .prepare(`SELECT ${cols} FROM \`${table}\` WHERE \`${spec.pk}\` = ?`)
    .get(rowId) as Record<string, unknown> | undefined;
  return row ?? null;
}

function groupOps(rows: OplogRow[]): Map<string, RowGroup> {
  const groups = new Map<string, RowGroup>();
  for (const op of rows) {
    const k = `${op.table_name}\u0000${op.row_id}`;
    const existing = groups.get(k);
    if (existing) {
      existing.ops.push(op);
    } else {
      groups.set(k, { table: op.table_name, rowId: op.row_id, ops: [op] });
    }
  }
  return groups;
}

function buildSnapshot(
  raw: Database,
  group: RowGroup,
): RowSnapshot | Tombstone | null {
  const last = group.ops[group.ops.length - 1];
  const wallMs = Math.max(...group.ops.map((o) => o.wall_ms));

  if (last.op === 'delete') {
    // 窗口内先增后删：对端本来就没有这行，不必推
    if (group.ops.some((o) => o.op === 'insert')) return null;
    return { table: group.table, rowId: group.rowId, wallMs };
  }

  const values = readRow(raw, group.table, group.rowId);
  if (!values) {
    return { table: group.table, rowId: group.rowId, wallMs };
  }

  const hadInsert = group.ops.some((o) => o.op === 'insert');
  let changedFields: string[] | null = hadInsert ? null : [];

  if (!hadInsert) {
    const fields = new Set<string>();
    for (const op of group.ops) {
      if (op.op !== 'update') continue;
      for (const f of parseChangedFields(op.changed_fields) ?? []) fields.add(f);
    }
    changedFields = [...fields];
  }

  return {
    table: group.table,
    rowId: group.rowId,
    values,
    changedFields,
    wallMs,
  };
}

/**
 * 从 oplog 提取自 sinceSeq 以来的变更，组装成可发送给对端的 ChangeSet。
 *
 * sinceSeq 是上次成功同步时记录的对端水位线在本机 oplog 上的位置；
 * 0 表示全量。
 */
export function collectChangeSet(
  raw: Database,
  deviceId: string,
  sinceSeq: number,
): ChangeSet {
  const rows = raw
    .prepare(
      `SELECT seq, table_name, row_id, op, wall_ms, changed_fields
       FROM sync_oplog
       WHERE seq > ?
       ORDER BY seq ASC`,
    )
    .all(sinceSeq) as OplogRow[];

  const headRow = raw
    .prepare(`SELECT coalesce(max(seq), 0) AS head FROM sync_oplog`)
    .get() as { head: number };

  const snapshots: RowSnapshot[] = [];
  const tombstones: Tombstone[] = [];

  for (const group of groupOps(rows).values()) {
    const item = buildSnapshot(raw, group);
    if (!item) continue;
    if ('values' in item) {
      snapshots.push(item);
    } else {
      tombstones.push(item);
    }
  }

  return {
    deviceId,
    headSeq: headRow.head,
    rows: snapshots,
    tombstones,
  };
}

/** 当前 oplog 头部位置 */
export function currentHeadSeq(raw: Database): number {
  const row = raw.prepare(`SELECT coalesce(max(seq), 0) AS head FROM sync_oplog`).get() as {
    head: number;
  };
  return row.head;
}

/**
 * 全量快照：扫描所有同步表的当前行，并附带 oplog 中的删除墓碑。
 * 用于首次配对、切换对端、或显式全量同步——仅靠 oplog 会漏掉
 * 从其他设备同步过来、未记入本机 oplog 的行。
 */
export function collectFullChangeSet(raw: Database, deviceId: string): ChangeSet {
  const snapshots: RowSnapshot[] = [];

  for (const spec of syncTableSpecs()) {
    const cols = spec.columns.map((c) => `\`${c}\``).join(', ');
    const rows = raw
      .prepare(`SELECT ${cols} FROM \`${spec.name}\``)
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      snapshots.push({
        table: spec.name,
        rowId: String(row[spec.pk]),
        values: row,
        changedFields: null,
        wallMs: Date.now(),
      });
    }
  }

  const incremental = collectChangeSet(raw, deviceId, 0);
  const rowKeys = new Set(snapshots.map((r) => `${r.table}\u0000${r.rowId}`));
  const tombstones = incremental.tombstones.filter(
    (t) => !rowKeys.has(`${t.table}\u0000${t.rowId}`),
  );

  return {
    deviceId,
    headSeq: incremental.headSeq,
    rows: snapshots,
    tombstones,
  };
}
