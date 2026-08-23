import type { SQLiteDatabase } from 'expo-sqlite';
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
  raw: SQLiteDatabase,
  table: string,
  rowId: string,
): Record<string, unknown> | null {
  const spec = syncTableSpec(table);
  const cols = spec.columns.map((c) => `\`${c}\``).join(', ');
  const row = raw.getFirstSync<Record<string, unknown>>(
    `SELECT ${cols} FROM \`${table}\` WHERE \`${spec.pk}\` = ?`,
    rowId,
  );
  return row ?? null;
}

/**
 * 这一行最后一次更新的时间。
 *
 * 取 sync_row_version 而不是窗口内最后一条 oplog 的时间：从对端同步进来的
 * 行不写 oplog，只看 oplog 会把这行的时间说早了，全量与增量两条采集路径也
 * 会对同一行报出不同的时间。
 */
function rowVersion(raw: SQLiteDatabase, table: string, rowId: string): number | null {
  const row = raw.getFirstSync<{ updated_ms: number }>(
    `SELECT updated_ms FROM sync_row_version WHERE table_name = ? AND row_id = ?`,
    table,
    rowId,
  );
  return row?.updated_ms ?? null;
}

export function collectChangeSet(
  raw: SQLiteDatabase,
  deviceId: string,
  sinceSeq: number,
): ChangeSet {
  const rows = raw.getAllSync<OplogRow>(
    `SELECT seq, table_name, row_id, op, wall_ms, changed_fields
     FROM sync_oplog WHERE seq > ? ORDER BY seq ASC`,
    sinceSeq,
  );

  const head =
    raw.getFirstSync<{ head: number }>(`SELECT coalesce(max(seq), 0) AS head FROM sync_oplog`)
      ?.head ?? 0;

  const groups = new Map<string, OplogRow[]>();
  for (const op of rows) {
    const k = `${op.table_name}\u0000${op.row_id}`;
    const g = groups.get(k);
    if (g) g.push(op);
    else groups.set(k, [op]);
  }

  const snapshots: RowSnapshot[] = [];
  const tombstones: Tombstone[] = [];

  for (const ops of groups.values()) {
    const last = ops[ops.length - 1];
    const wallMs = Math.max(...ops.map((o) => o.wall_ms));
    const table = last.table_name;
    const rowId = last.row_id;

    if (last.op === 'delete') {
      if (ops.some((o) => o.op === 'insert')) continue;
      tombstones.push({ table, rowId, wallMs });
      continue;
    }

    const values = readRow(raw, table, rowId);
    if (!values) {
      tombstones.push({ table, rowId, wallMs });
      continue;
    }

    const hadInsert = ops.some((o) => o.op === 'insert');
    let changedFields: string[] | null = hadInsert ? null : [];
    if (!hadInsert) {
      const fields = new Set<string>();
      for (const op of ops) {
        if (op.op !== 'update') continue;
        for (const f of parseChangedFields(op.changed_fields) ?? []) fields.add(f);
      }
      changedFields = [...fields];
    }

    snapshots.push({
      table,
      rowId,
      values,
      changedFields,
      wallMs: rowVersion(raw, table, rowId) ?? wallMs,
    });
  }

  return { deviceId, headSeq: head, rows: snapshots, tombstones };
}

/**
 * 全量快照，语义与桌面端 collectFullChangeSet 一致。
 *
 * 每行的时间取自 sync_row_version 而不是 Date.now()：全表快照里所有行都盖上
 * "现在"的话，后写覆盖就变成了"谁先发起同步谁赢"。
 */
export function collectFullChangeSet(raw: SQLiteDatabase, deviceId: string): ChangeSet {
  const snapshots: RowSnapshot[] = [];

  for (const spec of syncTableSpecs()) {
    const cols = spec.columns.map((c) => `t.\`${c}\``).join(', ');
    const rows = raw.getAllSync<Record<string, unknown>>(
      `SELECT ${cols}, coalesce(v.updated_ms, 0) AS __updated_ms
         FROM \`${spec.name}\` t
         LEFT JOIN sync_row_version v
           ON v.table_name = '${spec.name}' AND v.row_id = t.\`${spec.pk}\``,
    );
    for (const row of rows) {
      const { __updated_ms: updatedMs, ...values } = row;
      snapshots.push({
        table: spec.name,
        rowId: String(values[spec.pk]),
        values,
        changedFields: null,
        wallMs: Number(updatedMs),
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
