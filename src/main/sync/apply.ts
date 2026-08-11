import type { Database } from 'better-sqlite3';
import type { AutoChange } from '@shared/sync';
import { deviceLocalInsertDefaults } from './deviceLocalDefaults';
import { syncTableSpec, syncTableSpecs } from './tables';
import { writingAs } from './triggers';

/**
 * 同步表的依赖顺序：插入时父表在前，删除时子表在前。
 * 不在清单里的表不会被同步。
 */
const INSERT_ORDER = syncTableSpecs().map((s) => s.name);

const DELETE_ORDER = [...INSERT_ORDER].reverse();

function sortChanges(changes: AutoChange[]): AutoChange[] {
  const order = (table: string, kind: AutoChange['kind']): number => {
    const list = kind === 'delete' ? DELETE_ORDER : INSERT_ORDER;
    const idx = list.indexOf(table);
    return idx === -1 ? 999 : idx;
  };

  return [...changes].sort((a, b) => {
    const kindOrder = { delete: 0, patch: 1, insert: 2 };
    const ka = kindOrder[a.kind];
    const kb = kindOrder[b.kind];
    if (ka !== kb) return ka - kb;
    return order(a.table, a.kind) - order(b.table, b.kind);
  });
}

function bindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function applyInsert(
  raw: Database,
  table: string,
  rowId: string,
  values: Record<string, unknown>,
): void {
  const spec = syncTableSpec(table);
  const existing = raw
    .prepare(`SELECT * FROM \`${table}\` WHERE \`${spec.pk}\` = ?`)
    .get(rowId) as Record<string, unknown> | undefined;

  const merged = { ...values };
  if (existing) {
    for (const col of spec.deviceLocal) {
      merged[col] = existing[col];
    }
  } else {
    const defaults = deviceLocalInsertDefaults(table, merged);
    for (const col of spec.deviceLocal) {
      if (merged[col] === undefined && col in defaults) merged[col] = defaults[col];
    }
  }

  const cols = Object.keys(merged);
  const placeholders = cols.map(() => '?').join(', ');
  const colNames = cols.map((c) => `\`${c}\``).join(', ');
  raw
    .prepare(
      `INSERT OR REPLACE INTO \`${table}\` (${colNames}) VALUES (${placeholders})`,
    )
    .run(...cols.map((c) => bindValue(merged[c])));
}

function applyPatch(
  raw: Database,
  table: string,
  rowId: string,
  values: Record<string, unknown>,
): void {
  const spec = syncTableSpec(table);
  const entries = Object.entries(values).filter(([col]) => !spec.deviceLocal.includes(col));
  if (entries.length === 0) return;

  const sets = entries.map(([col]) => `\`${col}\` = ?`).join(', ');
  raw
    .prepare(`UPDATE \`${table}\` SET ${sets} WHERE \`${spec.pk}\` = ?`)
    .run(...entries.map(([, v]) => bindValue(v)), rowId);
}

function applyDelete(raw: Database, table: string, rowId: string): void {
  const spec = syncTableSpec(table);
  raw.prepare(`DELETE FROM \`${table}\` WHERE \`${spec.pk}\` = ?`).run(rowId);
}

/**
 * 把合并计划里的自动变更事务性落库。
 *
 * 写入期间标记 writeAs 为对端设备，触发器不会把这些变更再记成本机
 * 待推送的修改。
 */
export function applyAutoChanges(
  raw: Database,
  peerDeviceId: string,
  changes: AutoChange[],
): number {
  const sorted = sortChanges(changes);
  let applied = 0;

  writingAs(raw, peerDeviceId, () => {
    raw.transaction(() => {
      for (const change of sorted) {
        if (change.kind === 'insert') {
          applyInsert(raw, change.table, change.rowId, {
            ...change.values,
            [syncTableSpec(change.table).pk]: change.rowId,
          });
        } else if (change.kind === 'patch') {
          applyPatch(raw, change.table, change.rowId, change.values);
        } else {
          applyDelete(raw, change.table, change.rowId);
        }
        applied++;
      }
    })();
  });

  return applied;
}
