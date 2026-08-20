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

function buildTriggerSql(spec: SyncTableSpec, localDeviceId: string): string[] {
  return [insertTrigger(spec, localDeviceId), updateTrigger(spec, localDeviceId), deleteTrigger(spec, localDeviceId)];
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
      const m = /^sync_(.+)_(ai|au|ad)$/.exec(name);
      if (m && !known.has(m[1])) {
        raw.execSync(`DROP TRIGGER IF EXISTS ${name};`);
      }
    }

    for (const spec of specs) {
      for (const suffix of ['ai', 'au', 'ad']) {
        raw.execSync(`DROP TRIGGER IF EXISTS sync_${spec.name}_${suffix};`);
      }
      for (const sql of buildTriggerSql(spec, localDeviceId)) {
        raw.execSync(sql);
      }
    }

    // 清掉清单外表的 oplog 残留，collect/apply 不再读到未知表
    const placeholders = specs.map(() => '?').join(', ');
    raw.runSync(
      `DELETE FROM sync_oplog WHERE table_name NOT IN (${placeholders})`,
      ...(specs.map((s) => s.name) as (string | number | null)[]),
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
