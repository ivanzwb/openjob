import type { Database } from 'better-sqlite3';
import type { AutoChange } from '@shared/sync';
import { deviceLocalInsertDefaults } from './deviceLocalDefaults';
import { describeMissingParents, type FkProbe } from './fkDiagnostics';
import { syncTableSpec, syncTableSpecs } from './tables';
import { upsertClause } from './upsert';
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
    // delete 在最前是语义要求：同一行 id 被删掉又重建时，顺序反了就等于没删。
    //
    // insert 早于 patch、父表早于子表则是外键顺序，但它已经不是唯一防线——
    // 落库事务里开了 defer_foreign_keys，外键推迟到提交时统一检查。排序错了
    // 不再报 FOREIGN KEY constraint failed，这里只是让语句顺序符合直觉。
    const kindOrder = { delete: 0, insert: 1, patch: 2 };
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
      `INSERT INTO \`${table}\` (${colNames}) VALUES (${placeholders}) ${upsertClause(spec.pk, cols)}`,
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
 * 把这一行的版本时间改写成数据在来源端的更新时间。
 *
 * 触发器刚刚盖上的是本机当前时间，必须纠正：否则本机副本会因为"刚写入"
 * 而显得比来源更新，下一轮同步又被当作新值推回去，两端在同一个值上反复
 * 互相覆盖，水位线永远追不上。
 */
function stampRowVersion(raw: Database, table: string, rowId: string, wallMs: number): void {
  raw
    .prepare(
      `INSERT INTO sync_row_version (table_name, row_id, updated_ms) VALUES (?, ?, ?)
       ON CONFLICT(table_name, row_id) DO UPDATE SET updated_ms = excluded.updated_ms`,
    )
    .run(table, rowId, wallMs);
}

function fkProbe(raw: Database): FkProbe {
  return {
    foreignKeys: (table) =>
      (
        raw.pragma(`foreign_key_list('${table}')`) as {
          table: string;
          from: string;
          to: string | null;
        }[]
      ).map((r) => ({
        column: r.from,
        parentTable: r.table,
        parentColumn: r.to ?? 'id',
      })),
    parentExists: (parentTable, parentColumn, value) =>
      raw
        .prepare(`SELECT 1 FROM \`${parentTable}\` WHERE \`${parentColumn}\` = ? LIMIT 1`)
        .get(value as string) !== undefined,
  };
}

/** 给外键报错补上"是哪张表的哪一行"，诊断失败时原样抛出原始错误 */
function annotateForeignKeyError(raw: Database, error: unknown, changes: AutoChange[]): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/FOREIGN KEY constraint failed/i.test(message)) return error;
  try {
    const detail = describeMissingParents(changes, fkProbe(raw));
    if (detail) return new Error(`${message}｜${detail}`);
  } catch {
    // 诊断本身出错不能盖掉真正的失败原因
  }
  return error;
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
    const run = raw.transaction(() => {
      // 外键检查推迟到提交时整批做一次。planMerge 逐行独立决策，父行和子行
      // 落库的先后顺序本质上无法保证正确——靠 INSERT_ORDER 人工维护拓扑序，
      // 每加一张表就多一次踩中 FOREIGN KEY constraint failed 的机会。推迟之后
      // 中间状态不再被检查，只要整批结束时引用完整就能提交。
      raw.exec('PRAGMA defer_foreign_keys = ON');

      for (const change of sorted) {
        if (change.kind === 'insert') {
          applyInsert(raw, change.table, change.rowId, {
            ...change.values,
            [syncTableSpec(change.table).pk]: change.rowId,
          });
          stampRowVersion(raw, change.table, change.rowId, change.wallMs);
        } else if (change.kind === 'patch') {
          applyPatch(raw, change.table, change.rowId, change.values);
          stampRowVersion(raw, change.table, change.rowId, change.wallMs);
        } else {
          applyDelete(raw, change.table, change.rowId);
        }
        applied++;
      }
    });

    try {
      run();
    } catch (e) {
      throw annotateForeignKeyError(raw, e, sorted);
    }
  });

  return applied;
}
