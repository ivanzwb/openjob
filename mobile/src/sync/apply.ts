import type { SQLiteDatabase } from 'expo-sqlite';
import type { AutoChange } from '@shared/sync';
import { deviceLocalInsertDefaults } from '../../../src/main/sync/deviceLocalDefaults';
import {
  describeMissingParents,
  findMissingParentChanges,
  type FkProbe,
} from '../../../src/main/sync/fkDiagnostics';
import { upsertClause } from '../../../src/main/sync/upsert';
import { syncTableSpec, syncTableSpecs } from './tables';
import { writingAs } from './triggers';

const INSERT_ORDER = syncTableSpecs().map((s) => s.name);
const DELETE_ORDER = [...INSERT_ORDER].reverse();

function sortChanges(changes: AutoChange[]): AutoChange[] {
  const order = (table: string, kind: AutoChange['kind']): number => {
    const list = kind === 'delete' ? DELETE_ORDER : INSERT_ORDER;
    const idx = list.indexOf(table);
    return idx === -1 ? 999 : idx;
  };
  return [...changes].sort((a, b) => {
    // 与桌面端 src/main/sync/apply.ts 保持一致。
    //
    // delete 在最前是语义要求：同一行 id 被删掉又重建时，顺序反了就等于没删。
    // insert 早于 patch、父表早于子表则是外键顺序，但它已经不是唯一防线——
    // 落库事务里开了 defer_foreign_keys，外键推迟到提交时统一检查。
    const kindOrder = { delete: 0, insert: 1, patch: 2 };
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
    return order(a.table, a.kind) - order(b.table, b.kind);
  });
}

function bindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  // 与桌面端一致：数组/对象（constraints、exam_forms、citations 等）必须 JSON 化；
  // 不能把 JS 数组直接绑给 runSync，Hermes 会报 Exception in HostFunction: invalid auto data。
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function applyInsert(
  raw: SQLiteDatabase,
  table: string,
  rowId: string,
  values: Record<string, unknown>,
): void {
  const spec = syncTableSpec(table);
  const existing = raw.getFirstSync<Record<string, unknown>>(
    `SELECT * FROM \`${table}\` WHERE \`${spec.pk}\` = ?`,
    rowId,
  );
  const merged = { ...values };
  if (existing) {
    for (const col of spec.deviceLocal) merged[col] = existing[col];
  } else {
    const defaults = deviceLocalInsertDefaults(table, merged);
    for (const col of spec.deviceLocal) {
      if (merged[col] === undefined && col in defaults) merged[col] = defaults[col];
    }
  }
  const cols = Object.keys(merged);
  const placeholders = cols.map(() => '?').join(', ');
  const colNames = cols.map((c) => `\`${c}\``).join(', ');
  raw.runSync(
    `INSERT INTO \`${table}\` (${colNames}) VALUES (${placeholders}) ${upsertClause(spec.pk, cols)}`,
    ...(cols.map((c) => bindValue(merged[c])) as (string | number | null)[]),
  );
}

function applyPatch(
  raw: SQLiteDatabase,
  table: string,
  rowId: string,
  values: Record<string, unknown>,
): void {
  const spec = syncTableSpec(table);
  const entries = Object.entries(values).filter(([col]) => !spec.deviceLocal.includes(col));
  if (entries.length === 0) return;
  const sets = entries.map(([col]) => `\`${col}\` = ?`).join(', ');
  raw.runSync(
    `UPDATE \`${table}\` SET ${sets} WHERE \`${spec.pk}\` = ?`,
    ...(entries.map(([, v]) => bindValue(v)) as (string | number | null)[]),
    rowId,
  );
}

function applyDelete(raw: SQLiteDatabase, table: string, rowId: string): void {
  const spec = syncTableSpec(table);
  raw.runSync(`DELETE FROM \`${table}\` WHERE \`${spec.pk}\` = ?`, rowId);
}

/**
 * 把这一行的版本时间改写成数据在来源端的更新时间。
 *
 * 触发器刚刚盖上的是本机当前时间，必须纠正：否则本机副本会因为"刚写入"而
 * 显得比来源更新，下一轮同步又被当作新值推回去，两端反复互相覆盖。
 */
function stampRowVersion(
  raw: SQLiteDatabase,
  table: string,
  rowId: string,
  wallMs: number,
): void {
  raw.runSync(
    `INSERT INTO sync_row_version (table_name, row_id, updated_ms) VALUES (?, ?, ?)
     ON CONFLICT(table_name, row_id) DO UPDATE SET updated_ms = excluded.updated_ms`,
    table,
    rowId,
    wallMs,
  );
}

function fkProbe(raw: SQLiteDatabase): FkProbe {
  return {
    foreignKeys: (table) =>
      raw
        .getAllSync<{ table: string; from: string; to: string | null }>(
          `PRAGMA foreign_key_list('${table}')`,
        )
        .map((r) => ({
          column: r.from,
          parentTable: r.table,
          parentColumn: r.to ?? 'id',
        })),
    parentExists: (parentTable, parentColumn, value) =>
      raw.getFirstSync(
        `SELECT 1 FROM \`${parentTable}\` WHERE \`${parentColumn}\` = ? LIMIT 1`,
        value as string,
      ) !== null,
  };
}

/** 给外键报错补上"是哪张表的哪一行"，诊断失败时原样抛出原始错误 */
function annotateForeignKeyError(
  raw: SQLiteDatabase,
  error: unknown,
  changes: AutoChange[],
): unknown {
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

export interface ApplyAutoChangesResult {
  /** 实际落库的变更数（含 delete） */
  applied: number;
  /**
   * 因引用不存在的父行而被跳过的变更。父行本机没有、本批也不来，这些变更
   * 无论如何都落不了库——最常见的是本机删掉了父行、对端把它的子行按 insert
   * 复活（planMerge 逐行 LWW 的产物）。父行已删，子行不该被复活回来，
   * 跳过它们让同步收敛，而不是整批回滚、水位不动、每轮重试卡死在原地。
   */
  skipped: AutoChange[];
}

/**
 * 把合并计划里的自动变更事务性落库。
 *
 * 与桌面端 src/main/sync/apply.ts 保持同一套语义：提交碰到外键失败时不再
 * 整批报错，先用反查找出引用了不存在父行的变更，丢掉它们重试剩下的
 * （链式场景下一轮反查继续揪出下游变更），直到整批落库或无可落库。
 * 非外键错误和诊断失败仍然按原样抛出。
 */
export function applyAutoChanges(
  raw: SQLiteDatabase,
  peerDeviceId: string,
  changes: AutoChange[],
): ApplyAutoChangesResult {
  const sorted = sortChanges(changes);
  const skipped: AutoChange[] = [];
  let pending = sorted;

  writingAs(raw, peerDeviceId, () => {
    while (pending.length > 0) {
      try {
        raw.execSync('BEGIN');
        // 外键检查推迟到提交时整批做一次。planMerge 逐行独立决策，父行和子行
        // 落库的先后顺序本质上无法保证正确——靠 INSERT_ORDER 人工维护拓扑序，
        // 每加一张表就多一次踩中 FOREIGN KEY constraint failed 的机会。推迟之后
        // 中间状态不再被检查，只要整批结束时引用完整就能提交。
        raw.execSync('PRAGMA defer_foreign_keys = ON');
        try {
          for (const change of pending) {
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
          }
          raw.execSync('COMMIT');
        } catch (e) {
          raw.execSync('ROLLBACK');
          throw e;
        }
        break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!/FOREIGN KEY constraint failed/i.test(message)) throw e;

        let orphans: AutoChange[] = [];
        try {
          orphans = findMissingParentChanges(pending, fkProbe(raw));
        } catch {
          // 诊断本身出错不能盖掉真正的失败原因
        }
        if (orphans.length === 0) throw annotateForeignKeyError(raw, e, pending);

        skipped.push(...orphans);
        const orphanKeys = new Set(orphans.map((c) => `${c.table}:${c.rowId}:${c.kind}`));
        pending = pending.filter((c) => !orphanKeys.has(`${c.table}:${c.rowId}:${c.kind}`));
      }
    }
  });

  return { applied: changes.length - skipped.length, skipped };
}
