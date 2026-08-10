import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChangeSet, RowSnapshot, Tombstone } from '@shared/sync';
import { syncTableSpec } from './tables';

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

    snapshots.push({ table, rowId, values, changedFields, wallMs });
  }

  return { deviceId, headSeq: head, rows: snapshots, tombstones };
}

export function currentHeadSeq(raw: SQLiteDatabase): number {
  return (
    raw.getFirstSync<{ head: number }>(`SELECT coalesce(max(seq), 0) AS head FROM sync_oplog`)
      ?.head ?? 0
  );
}
