import type {
  AutoChange,
  ChangeSet,
  FieldConflict,
  MergePlan,
  RowSnapshot,
  Tombstone,
} from './sync';

/**
 * 合并规则的唯一实现，两端共用。
 *
 * 核心判断只有一条：只有当两端在同一水位线之后都改过同一行的同一列、
 * 且改成了不同的值，才算冲突。其余情况全部自动合并。
 *
 * 注意这里刻意不做「按时间戳取新的」的自动裁决。手机和电脑的时钟差
 * 完全可能有几秒，靠它决定谁覆盖谁会静默丢数据。时间戳只用来在冲突
 * 界面上告诉用户哪边更晚，决定权留给用户。
 */

export interface MergeContext {
  /** 对端时钟相对本机的偏移（毫秒），握手时测得。remoteLocalized = wallMs - offset */
  clockOffsetMs: number;
  /** 本机专属列，不接受对端值 */
  isDeviceLocal(table: string, column: string): boolean;
  /** 主键列名 */
  primaryKey(table: string): string;
  /** 冲突界面上展示的行标题 */
  labelFor(table: string, rowId: string, values: Record<string, unknown>): string;
}

type Key = string;

function key(table: string, rowId: string): Key {
  return `${table}\u0000${rowId}`;
}

/** SQLite 取回的值只有 string / number / null / Buffer，字符串化比较足够且便宜 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Indexed {
  rows: Map<Key, RowSnapshot>;
  tombstones: Map<Key, Tombstone>;
}

function indexChangeSet(cs: ChangeSet): Indexed {
  const rows = new Map<Key, RowSnapshot>();
  const tombstones = new Map<Key, Tombstone>();
  for (const r of cs.rows) rows.set(key(r.table, r.rowId), r);
  for (const t of cs.tombstones) tombstones.set(key(t.table, t.rowId), t);
  // 同一行既有修改又有删除时，删除是终态
  for (const k of tombstones.keys()) rows.delete(k);
  return { rows, tombstones };
}

function strip(
  ctx: MergeContext,
  table: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (ctx.isDeviceLocal(table, k)) continue;
    out[k] = v;
  }
  return out;
}

export function planMerge(local: ChangeSet, remote: ChangeSet, ctx: MergeContext): MergePlan {
  const l = indexChangeSet(local);
  const r = indexChangeSet(remote);

  const auto: AutoChange[] = [];
  const conflicts: FieldConflict[] = [];

  // 只需要遍历对端的变更：本机自己的改动本来就已经在库里了
  const remoteKeys = new Set<Key>([...r.rows.keys(), ...r.tombstones.keys()]);

  for (const k of remoteKeys) {
    const remoteRow = r.rows.get(k);
    const remoteTomb = r.tombstones.get(k);
    const localRow = l.rows.get(k);
    const localTomb = l.tombstones.get(k);

    const table = (remoteRow ?? remoteTomb)!.table;
    const rowId = (remoteRow ?? remoteTomb)!.rowId;
    const localTouched = Boolean(localRow || localTomb);

    // 对端删除
    if (remoteTomb) {
      if (localTomb) continue; // 两边都删了，天然一致
      if (!localRow) {
        auto.push({ table, rowId, kind: 'delete', values: {} });
        continue;
      }
      // 一端删除、另一端修改：没有能自动做对的选择，交给用户
      conflicts.push({
        table,
        rowId,
        field: 'delete',
        localValue: '已修改',
        remoteValue: '已删除',
        localWallMs: localRow.wallMs,
        remoteWallMs: remoteTomb.wallMs - ctx.clockOffsetMs,
        label: ctx.labelFor(table, rowId, localRow.values),
      });
      continue;
    }

    if (!remoteRow) continue;

    // 本机删了、对端改了，方向相反的同一种冲突
    if (localTomb) {
      conflicts.push({
        table,
        rowId,
        field: 'delete',
        localValue: '已删除',
        remoteValue: '已修改',
        localWallMs: localTomb.wallMs,
        remoteWallMs: remoteRow.wallMs - ctx.clockOffsetMs,
        label: ctx.labelFor(table, rowId, remoteRow.values),
      });
      continue;
    }

    // 本机没动过这一行，对端的值直接采纳
    if (!localTouched || !localRow) {
      auto.push({ table, rowId, kind: 'insert', values: strip(ctx, table, remoteRow.values) });
      continue;
    }

    // 两端都改过，逐列比对
    const pk = ctx.primaryKey(table);
    const candidates = remoteRow.changedFields ?? Object.keys(remoteRow.values);
    const patch: Record<string, unknown> = {};

    for (const field of candidates) {
      if (field === pk) continue;
      if (ctx.isDeviceLocal(table, field)) continue;

      const remoteValue = remoteRow.values[field];
      const localValue = localRow.values[field];

      // 本机这一列没动过 —— 不构成分歧，采纳对端
      const localChangedThisField =
        localRow.changedFields === null || localRow.changedFields.includes(field);

      if (!localChangedThisField) {
        patch[field] = remoteValue;
        continue;
      }

      // 两端都动了，但改成了同一个值，也不算分歧
      if (sameValue(localValue, remoteValue)) continue;

      conflicts.push({
        table,
        rowId,
        field,
        localValue,
        remoteValue,
        localWallMs: localRow.wallMs,
        remoteWallMs: remoteRow.wallMs - ctx.clockOffsetMs,
        label: ctx.labelFor(table, rowId, localRow.values),
      });
    }

    if (Object.keys(patch).length > 0) {
      auto.push({ table, rowId, kind: 'patch', values: patch });
    }
  }

  return { auto, conflicts };
}

/**
 * 把用户的裁决结果转成待落库的变更。
 * 选「本机」的冲突不产生任何写入——本机已经是那个值了。
 */
export function resolutionsToChanges(
  conflicts: FieldConflict[],
  choices: Map<string, 'local' | 'remote'>,
  remote: ChangeSet,
): AutoChange[] {
  const remoteRows = new Map<Key, RowSnapshot>();
  for (const row of remote.rows) remoteRows.set(key(row.table, row.rowId), row);

  const byRow = new Map<Key, AutoChange>();

  for (const c of conflicts) {
    if (choices.get(conflictKey(c)) !== 'remote') continue;
    const k = key(c.table, c.rowId);

    if (c.field === 'delete') {
      // 采纳对端：对端删了就删，对端改了就整行覆盖
      const row = remoteRows.get(k);
      byRow.set(
        k,
        row
          ? { table: c.table, rowId: c.rowId, kind: 'insert', values: row.values }
          : { table: c.table, rowId: c.rowId, kind: 'delete', values: {} },
      );
      continue;
    }

    const existing = byRow.get(k);
    if (existing && existing.kind !== 'patch') continue;
    const patch = existing ?? {
      table: c.table,
      rowId: c.rowId,
      kind: 'patch' as const,
      values: {},
    };
    patch.values[c.field] = c.remoteValue;
    byRow.set(k, patch);
  }

  return [...byRow.values()];
}

/** 冲突的稳定标识，UI 用它记录用户选择 */
export function conflictKey(c: FieldConflict): string {
  return `${c.table}\u0000${c.rowId}\u0000${c.field}`;
}
