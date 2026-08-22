import type { SQLiteDatabase } from 'expo-sqlite';
import { syncTableSpecs, type SyncTableSpec } from './tables';

const WRITE_AS = `coalesce((SELECT value FROM sync_meta WHERE key = 'writeAs'), 'unknown')`;
const NOW_MS = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * 只有当写入者是本机时才记 oplog。应用对端变更时 writingAs() 把 writeAs
 * 改成对端 id，触发器看到不等于本机 id 就跳过——否则应用回来的数据会再
 * 写一条 oplog，被当成"本机新变更"推回来源设备，形成每轮同步互推回声、
 * 水位永久追不上的循环。
 */
function isLocalWrite(localDeviceId: string): string {
  return `(SELECT value FROM sync_meta WHERE key = 'writeAs') = '${localDeviceId}'`;
}

function insertTrigger(spec: SyncTableSpec, localDeviceId: string): string {
  return `
CREATE TRIGGER IF NOT EXISTS sync_${spec.name}_ai AFTER INSERT ON \`${spec.name}\`
WHEN ${isLocalWrite(localDeviceId)}
BEGIN
  INSERT INTO sync_oplog (table_name, row_id, op, wall_ms, device_id, changed_fields)
  VALUES ('${spec.name}', NEW.\`${spec.pk}\`, 'insert', ${NOW_MS}, ${WRITE_AS}, NULL);
END;`;
}

function deleteTrigger(spec: SyncTableSpec, localDeviceId: string): string {
  return `
CREATE TRIGGER IF NOT EXISTS sync_${spec.name}_ad AFTER DELETE ON \`${spec.name}\`
WHEN ${isLocalWrite(localDeviceId)}
BEGIN
  INSERT INTO sync_oplog (table_name, row_id, op, wall_ms, device_id, changed_fields)
  VALUES ('${spec.name}', OLD.\`${spec.pk}\`, 'delete', ${NOW_MS}, ${WRITE_AS}, NULL);
END;`;
}

function updateTrigger(spec: SyncTableSpec, localDeviceId: string): string {
  const tracked = spec.columns.filter((c) => c !== spec.pk);
  const anyChanged = tracked.map((c) => `OLD.\`${c}\` IS NOT NEW.\`${c}\``).join('\n     OR ');
  const fieldList = tracked
    .map((c) => `CASE WHEN OLD.\`${c}\` IS NOT NEW.\`${c}\` THEN ',"${c}"' ELSE '' END`)
    .join('\n      || ');

  return `
CREATE TRIGGER IF NOT EXISTS sync_${spec.name}_au AFTER UPDATE ON \`${spec.name}\`
WHEN ${anyChanged}
  AND ${isLocalWrite(localDeviceId)}
BEGIN
  INSERT INTO sync_oplog (table_name, row_id, op, wall_ms, device_id, changed_fields)
  VALUES (
    '${spec.name}',
    NEW.\`${spec.pk}\`,
    'update',
    ${NOW_MS},
    ${WRITE_AS},
    '[' || substr(
      ${fieldList}
    , 2) || ']'
  );
END;`;
}

/**
 * 行版本触发器：维护每一行最后一次更新的时间，后写覆盖靠它判新旧。
 *
 * 和 oplog 触发器相反，这三个**不**带 isLocalWrite 判断——应用对端数据时
 * 也要更新版本，否则从对端同步进来的行永远没有时间可比。落库后
 * applyAutoChanges 会把版本改写成来源端的时间。
 */
function rowVersionTriggerSql(spec: SyncTableSpec): string[] {
  const upsert = (rowIdExpr: string): string => `
  INSERT INTO sync_row_version (table_name, row_id, updated_ms)
  VALUES ('${spec.name}', ${rowIdExpr}, ${NOW_MS})
  ON CONFLICT(table_name, row_id) DO UPDATE SET updated_ms = excluded.updated_ms;`;

  const tracked = spec.columns.filter((c) => c !== spec.pk);
  const anyChanged = tracked.map((c) => `OLD.\`${c}\` IS NOT NEW.\`${c}\``).join('\n     OR ');

  return [
    `
CREATE TRIGGER IF NOT EXISTS syncrv_${spec.name}_ai AFTER INSERT ON \`${spec.name}\`
BEGIN${upsert(`NEW.\`${spec.pk}\``)}
END;`,
    `
CREATE TRIGGER IF NOT EXISTS syncrv_${spec.name}_au AFTER UPDATE ON \`${spec.name}\`
WHEN ${anyChanged}
BEGIN${upsert(`NEW.\`${spec.pk}\``)}
END;`,
    `
CREATE TRIGGER IF NOT EXISTS syncrv_${spec.name}_ad AFTER DELETE ON \`${spec.name}\`
BEGIN
  DELETE FROM sync_row_version
  WHERE table_name = '${spec.name}' AND row_id = OLD.\`${spec.pk}\`;
END;`,
  ];
}

function buildTriggerSql(spec: SyncTableSpec, localDeviceId: string): string[] {
  return [
    insertTrigger(spec, localDeviceId),
    updateTrigger(spec, localDeviceId),
    deleteTrigger(spec, localDeviceId),
    ...rowVersionTriggerSql(spec),
  ];
}

/**
 * 给存量数据补上行版本，只跑一次。
 *
 * 缺时间的行在后写覆盖里会被当成"最老"，第一次同步就可能被对端整体压掉，
 * 所以用现有信息尽量还原：oplog 里的最后一次改动最准，其次是业务表自己的
 * updated_at / created_at。
 */
export function backfillRowVersions(raw: SQLiteDatabase): void {
  const done = raw.getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key = 'rowVersionBackfilledAt'`,
  );
  if (done) return;

  raw.execSync('BEGIN');
  try {
    for (const spec of syncTableSpecs()) {
      const fallbacks = [
        `(SELECT max(o.wall_ms) FROM sync_oplog o
           WHERE o.table_name = '${spec.name}' AND o.row_id = t.\`${spec.pk}\`)`,
      ];
      if (spec.columns.includes('updated_at')) fallbacks.push('t.`updated_at`');
      if (spec.columns.includes('created_at')) fallbacks.push('t.`created_at`');
      fallbacks.push('0');

      // WHERE true 不是多余的：SELECT 后面直接跟 ON CONFLICT 时 SQLite 无法
      // 判断 ON 属于 join 还是 upsert，必须有 WHERE 断开
      raw.execSync(`
        INSERT INTO sync_row_version (table_name, row_id, updated_ms)
        SELECT '${spec.name}', t.\`${spec.pk}\`, coalesce(${fallbacks.join(', ')})
        FROM \`${spec.name}\` t
        WHERE true
        ON CONFLICT(table_name, row_id) DO NOTHING;
      `);
    }

    raw.runSync(
      `INSERT INTO sync_meta (key, value) VALUES ('rowVersionBackfilledAt', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(Date.now()),
    );
    raw.execSync('COMMIT');
  } catch (e) {
    raw.execSync('ROLLBACK');
    throw e;
  }
}

export function installSyncTriggers(raw: SQLiteDatabase, localDeviceId: string): void {
  const specs = syncTableSpecs();
  const known = new Set(specs.map((s) => s.name));

  raw.execSync('BEGIN');
  try {
    // 清理清单外表的残留触发器（如曾被移出清单的 search_cache）
    const triggers = raw.getAllSync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger'`,
    );
    for (const { name } of triggers) {
      const m = /^(?:sync|syncrv)_(.+)_(?:ai|au|ad)$/.exec(name);
      if (m && !known.has(m[1])) {
        raw.execSync(`DROP TRIGGER IF EXISTS ${name};`);
      }
    }

    for (const spec of specs) {
      for (const prefix of ['sync', 'syncrv']) {
        for (const suffix of ['ai', 'au', 'ad']) {
          raw.execSync(`DROP TRIGGER IF EXISTS ${prefix}_${spec.name}_${suffix};`);
        }
      }
      for (const sql of buildTriggerSql(spec, localDeviceId)) {
        raw.execSync(sql);
      }
    }

    // 清掉清单外表的残留，collect/apply 不再读到未知表
    const placeholders = specs.map(() => '?').join(', ');
    const names = specs.map((s) => s.name) as (string | number | null)[];
    raw.runSync(`DELETE FROM sync_oplog WHERE table_name NOT IN (${placeholders})`, ...names);
    raw.runSync(
      `DELETE FROM sync_row_version WHERE table_name NOT IN (${placeholders})`,
      ...names,
    );

    raw.execSync('COMMIT');
  } catch (e) {
    raw.execSync('ROLLBACK');
    throw e;
  }
}

export function writingAs<T>(raw: SQLiteDatabase, deviceId: string, fn: () => T): T {
  const previous = raw.getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key = 'writeAs'`,
  )?.value;

  raw.runSync(
    `INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    deviceId,
  );

  try {
    return fn();
  } finally {
    if (previous !== undefined) {
      raw.runSync(`UPDATE sync_meta SET value = ? WHERE key = 'writeAs'`, previous);
    }
  }
}
