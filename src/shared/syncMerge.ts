import type {
  AutoChange,
  ChangeSet,
  FieldOverwrite,
  MergePlan,
  RowSnapshot,
  Tombstone,
} from './sync';

/**
 * 合并规则的唯一实现，两端共用。
 *
 * 两条规则，按顺序适用：
 *
 * 1. 列级合并优先。两端改的是同一行的不同列时，两边的修改都保留——这种
 *    情况不是分歧，直接取新值合成一行。手机上改备注、电脑上改标题不该有
 *    一方被丢掉。
 * 2. 同一列真的改成了不同值，才按更新时间取新的，不打扰用户。
 *
 * 关于「取新的」的正确性：这要求两端独立算出同一个赢家，否则每轮同步各自
 * 覆盖对方，数据永远收敛不了。所以时间必须先按握手测得的时钟偏移归一，
 * 时间完全相同时还要有一个两端一致的兜底顺序（见 remoteWins）。
 *
 * 时间来自 sync_row_version 而不是 oplog：从对端同步进来的行不写 oplog，
 * 只靠 oplog 的话那些行没有时间可比。
 */

export interface MergeContext {
  /** 对端时钟相对本机的偏移（毫秒），握手时测得。remoteLocalized = wallMs - offset */
  clockOffsetMs: number;
  /** 本机专属列，不接受对端值 */
  isDeviceLocal(table: string, column: string): boolean;
  /** 主键列名 */
  primaryKey(table: string): string;
  /** 覆盖记录里展示的行标题 */
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

/**
 * 后写覆盖的判定。两端各自调用，必须得出同一个结论。
 *
 * 时间相同时按 deviceId 字典序定胜负：两端看到的是同一对 id，只是本机/对端
 * 的角色相反，取字典序更大的那个 id 能让双方选中同一边。少了这一条，同一
 * 毫秒内两端各改一次的列会在每轮同步里来回翻，永远不收敛。
 */
function remoteWins(
  localMs: number,
  remoteMs: number,
  localDeviceId: string,
  remoteDeviceId: string,
): boolean {
  if (remoteMs !== localMs) return remoteMs > localMs;
  return remoteDeviceId > localDeviceId;
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
  const overwrites: FieldOverwrite[] = [];

  /** 对端时间归一到本机时钟后才能和本机时间比较 */
  const localized = (wallMs: number): number => wallMs - ctx.clockOffsetMs;

  const winner = (localMs: number, remoteMs: number): 'local' | 'remote' =>
    remoteWins(localMs, remoteMs, local.deviceId, remote.deviceId) ? 'remote' : 'local';

  // 只需要遍历对端的变更：本机自己的改动本来就已经在库里了
  const remoteKeys = new Set<Key>([...r.rows.keys(), ...r.tombstones.keys()]);

  for (const k of remoteKeys) {
    const remoteRow = r.rows.get(k);
    const remoteTomb = r.tombstones.get(k);
    const localRow = l.rows.get(k);
    const localTomb = l.tombstones.get(k);

    const table = (remoteRow ?? remoteTomb)!.table;
    const rowId = (remoteRow ?? remoteTomb)!.rowId;

    // 对端删除
    if (remoteTomb) {
      if (localTomb) continue; // 两边都删了，天然一致
      const remoteMs = localized(remoteTomb.wallMs);

      if (!localRow) {
        auto.push({ table, rowId, kind: 'delete', values: {}, wallMs: remoteMs });
        continue;
      }

      // 一端删除、另一端修改：按时间取新的
      const keptSide = winner(localRow.wallMs, remoteMs);
      if (keptSide === 'remote') {
        auto.push({ table, rowId, kind: 'delete', values: {}, wallMs: remoteMs });
      }
      overwrites.push({
        table,
        rowId,
        field: 'delete',
        localValue: '已修改',
        remoteValue: '已删除',
        localWallMs: localRow.wallMs,
        remoteWallMs: remoteMs,
        keptSide,
        label: ctx.labelFor(table, rowId, localRow.values),
      });
      continue;
    }

    if (!remoteRow) continue;

    const remoteMs = localized(remoteRow.wallMs);

    // 本机删了、对端改了：对端更晚就把行救回来
    if (localTomb) {
      const keptSide = winner(localTomb.wallMs, remoteMs);
      if (keptSide === 'remote') {
        auto.push({
          table,
          rowId,
          kind: 'insert',
          values: strip(ctx, table, remoteRow.values),
          wallMs: remoteMs,
        });
      }
      overwrites.push({
        table,
        rowId,
        field: 'delete',
        localValue: '已删除',
        remoteValue: '已修改',
        localWallMs: localTomb.wallMs,
        remoteWallMs: remoteMs,
        keptSide,
        label: ctx.labelFor(table, rowId, remoteRow.values),
      });
      continue;
    }

    // 本机没动过这一行，对端的值直接采纳
    if (!localRow) {
      auto.push({
        table,
        rowId,
        kind: 'insert',
        values: strip(ctx, table, remoteRow.values),
        wallMs: remoteMs,
      });
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

      const keptSide = winner(localRow.wallMs, remoteMs);
      if (keptSide === 'remote') patch[field] = remoteValue;

      overwrites.push({
        table,
        rowId,
        field,
        localValue,
        remoteValue,
        localWallMs: localRow.wallMs,
        remoteWallMs: remoteMs,
        keptSide,
        label: ctx.labelFor(table, rowId, localRow.values),
      });
    }

    if (Object.keys(patch).length > 0) {
      // 合成行同时含两端的值，版本时间取较晚的一个；两端算出的结果相同
      auto.push({
        table,
        rowId,
        kind: 'patch',
        values: patch,
        wallMs: Math.max(localRow.wallMs, remoteMs),
      });
    }
  }

  return { auto, overwrites };
}
