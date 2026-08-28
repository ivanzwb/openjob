import type { AutoChange } from '@shared/sync';

export interface ForeignKeyRef {
  /** 子表上的外键列 */
  column: string;
  parentTable: string;
  /** 被引用的父表列，通常是主键 */
  parentColumn: string;
}

export interface FkProbe {
  /** 读 PRAGMA foreign_key_list，只碰 schema，不扫数据 */
  foreignKeys(table: string): ForeignKeyRef[];
  /** 走主键索引的点查 */
  parentExists(parentTable: string, parentColumn: string, value: unknown): boolean;
}

/**
 * 落库失败时指出到底哪一行引用了不存在的父行。
 *
 * 裸的 "FOREIGN KEY constraint failed" 既不带表名也不带行号，同一句话从
 * v0.6.11 到 v0.6.13 反复出现，每次都得靠猜是哪张表——排查成本几乎全耗在
 * 这一句话上。
 *
 * 反查的是本批变更而不是 PRAGMA foreign_key_check：后者要在提交前扫全表，
 * repo_file 上每轮同步扫一遍代价太大，而且事务一回滚违规行就看不见了。
 * 照着变更逐条点查父行，回滚之后依然查得出来，报的还是"哪条下发的变更是
 * 坏的"——这才是排查时要的信息。
 */
/**
 * 落库失败时指出到底哪一行引用了不存在的父行。
 *
 * 裸的 "FOREIGN KEY constraint failed" 既不带表名也不带行号，同一句话从
 * v0.6.11 到 v0.6.13 反复出现，每次都得靠猜是哪张表——排查成本几乎全耗在
 * 这一句话上。
 *
 * 反查的是本批变更而不是 PRAGMA foreign_key_check：后者要在提交前扫全表，
 * repo_file 上每轮同步扫一遍代价太大，而且事务一回滚违规行就看不见了。
 * 照着变更逐条点查父行，回滚之后依然查得出来，报的还是"哪条下发的变更是
 * 坏的"——这才是排查时要的信息。
 */
function analyzeMissingParents(
  changes: AutoChange[],
  probe: FkProbe,
): { missing: AutoChange[]; groups: Map<string, { count: number; samples: string[] }> } {
  // 同批插入的父行在回滚后已经不存在了，不能算缺失
  const insertedInBatch = new Set(
    changes.filter((c) => c.kind === 'insert').map((c) => `${c.table}:${c.rowId}`),
  );

  const groups = new Map<string, { count: number; samples: string[] }>();
  const fkCache = new Map<string, ForeignKeyRef[]>();
  const missing: AutoChange[] = [];

  for (const change of changes) {
    if (change.kind === 'delete') continue;

    let fks = fkCache.get(change.table);
    if (!fks) {
      fks = probe.foreignKeys(change.table);
      fkCache.set(change.table, fks);
    }

    let broken = false;
    for (const fk of fks) {
      const value = change.values[fk.column];
      if (value === null || value === undefined) continue;
      if (insertedInBatch.has(`${fk.parentTable}:${String(value)}`)) continue;
      if (probe.parentExists(fk.parentTable, fk.parentColumn, value)) continue;

      broken = true;
      const key = `${change.table}.${fk.column} → ${fk.parentTable}`;
      const group = groups.get(key) ?? { count: 0, samples: [] };
      group.count++;
      if (group.samples.length < 3) group.samples.push(`${change.rowId}→${String(value)}`);
      groups.set(key, group);
    }
    if (broken) missing.push(change);
  }

  return { missing, groups };
}

/**
 * 找出本批里引用了不存在父行的变更——父行要么被本机删过、要么从未存在过，
 * 本批也没有它的 insert。这些变更无论如何都落不了库，丢给上层决定怎么处理。
 */
export function findMissingParentChanges(changes: AutoChange[], probe: FkProbe): AutoChange[] {
  return analyzeMissingParents(changes, probe).missing;
}

export function describeMissingParents(changes: AutoChange[], probe: FkProbe): string {
  const { groups } = analyzeMissingParents(changes, probe);

  if (groups.size === 0) return '';

  const parts = [...groups].map(
    ([key, { count, samples }]) => `${key}（${count} 行，如 ${samples.join('、')}）`,
  );
  return `以下变更引用了不存在的父行：${parts.join('；')}`;
}
