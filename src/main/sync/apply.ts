import type { Database } from 'better-sqlite3';
import type { AutoChange } from '@shared/sync';
import { deviceLocalInsertDefaults } from './deviceLocalDefaults';
import {
  describeMissingParents,
  findMissingParentChanges,
  findMissingParents,
  type FkProbe,
} from './fkDiagnostics';
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
 * 记录这一批到底缺了哪些父行，以及本机对它们的记忆。
 *
 * 只报"跳过了 N 条"说不清成因，而缺失父行在本机 oplog 里的最后一条记录恰好
 * 把成因分成两类，要查的方向完全不同：
 * - 最后一条是 delete：本机删过这个父行，而对端还留着它的子行。要查的是这次
 *   删除为什么没能传播到对端。
 * - 一条都没有：本机从来没有过这个父行。要查的是它为什么没被同步过来。
 */
function logMissingParents(raw: Database, dropped: AutoChange[], probe: FkProbe): void {
  console.warn(
    `[sync] 跳过 ${dropped.length} 条引用已删除父行的变更：${describeMissingParents(dropped, probe)}`,
  );

  for (const parent of findMissingParents(dropped, probe)) {
    const entry = raw
      .prepare(
        `SELECT op, wall_ms FROM sync_oplog
         WHERE table_name = ? AND row_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(parent.table, parent.rowId) as { op: string; wall_ms: number } | undefined;
    const memory =
      entry === undefined
        ? '本机 oplog 里没有它的任何记录 —— 它很可能从未同步过来'
        : `本机 oplog 最后一条是 ${entry.op}，时间 ${new Date(entry.wall_ms).toISOString()}`;
    console.warn(`[sync]   缺失父行 ${parent.table}:${parent.rowId} —— ${memory}`);
  }
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

function applyOne(raw: Database, change: AutoChange): void {
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

const changeKey = (c: AutoChange): string => `${c.table}:${c.rowId}:${c.kind}`;

/**
 * 外键失败后的补救：删除先落库，再就地反查孤儿、丢掉，然后落其余的。
 *
 * 反查放在删除之后是必须的，不是顺手：本批的 delete 可能通过外键级联带走
 * 另一条 insert 的父行。回滚之后再反查，看到的是删除前的库，那个父行还在，
 * 于是这条 insert 不会被判成孤儿，重试还是同样失败。删除落库之后再问，
 * parentExists 看到的才是级联之后的真实状态。
 *
 * 反查在内存里迭代到不动点，不靠"回滚—重试—再回滚"推进链式场景：被丢掉的
 * 变更恰好是另一条变更的父行时，下一轮迭代把下游一并揪出来。整批带着
 * repo_file 源码快照时，少一次重跑就是少几十 MB 的重复写入。
 */
function salvageOrphans(
  raw: Database,
  sorted: AutoChange[],
  cause: unknown,
): ApplyAutoChangesResult {
  const deletes = sorted.filter((c) => c.kind === 'delete');
  const writes = sorted.filter((c) => c.kind !== 'delete');
  let skipped: AutoChange[] = [];
  let applied = 0;

  const run = raw.transaction(() => {
    raw.exec('PRAGMA defer_foreign_keys = ON');
    for (const change of deletes) applyOne(raw, change);

    const probe = fkProbe(raw);
    let pending = writes;
    const dropped: AutoChange[] = [];
    for (;;) {
      const orphans = findMissingParentChanges(pending, probe);
      if (orphans.length === 0) break;
      dropped.push(...orphans);
      const keys = new Set(orphans.map(changeKey));
      pending = pending.filter((c) => !keys.has(changeKey(c)));
    }

    // 反查说不出哪一条坏，就不该假装修好了：把原始失败抛回去，让上层带诊断报出来
    if (dropped.length === 0) throw cause;

    logMissingParents(raw, dropped, probe);
    for (const change of pending) applyOne(raw, change);

    skipped = dropped;
    applied = deletes.length + pending.length;
  });

  try {
    run();
  } catch (e) {
    throw annotateForeignKeyError(raw, e, sorted);
  }

  return { applied, skipped };
}

/**
 * 把合并计划里的自动变更事务性落库。
 *
 * 写入期间标记 writeAs 为对端设备，触发器不会把这些变更再记成本机
 * 待推送的修改。
 *
 * 先乐观地整批落一次，不做任何额外查询——绝大多数轮次里没有孤儿，这条路径
 * 不该为极少数的坏批次买单。只有真的撞了外键才转入补救，丢掉引用不存在父行
 * 的那几条、落下其余的。非外键错误仍然按原样抛出。
 */
export function applyAutoChanges(
  raw: Database,
  peerDeviceId: string,
  changes: AutoChange[],
): ApplyAutoChangesResult {
  const sorted = sortChanges(changes);
  let result: ApplyAutoChangesResult = { applied: 0, skipped: [] };

  writingAs(raw, peerDeviceId, () => {
    try {
      raw.transaction(() => {
        // 外键检查推迟到提交时整批做一次。planMerge 逐行独立决策，父行和子行
        // 落库的先后顺序本质上无法保证正确——靠 INSERT_ORDER 人工维护拓扑序，
        // 每加一张表就多一次踩中 FOREIGN KEY constraint failed 的机会。推迟之后
        // 中间状态不再被检查，只要整批结束时引用完整就能提交。
        raw.exec('PRAGMA defer_foreign_keys = ON');
        for (const change of sorted) applyOne(raw, change);
      })();
      result = { applied: sorted.length, skipped: [] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/FOREIGN KEY constraint failed/i.test(message)) throw e;
      result = salvageOrphans(raw, sorted, e);
    }
  });

  return result;
}
