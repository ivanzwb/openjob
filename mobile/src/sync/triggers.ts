import type { SQLiteDatabase } from 'expo-sqlite';
import { syncTableSpecs, type SyncTableSpec } from './tables';

const WRITE_AS = `coalesce((SELECT value FROM sync_meta WHERE key = 'writeAs'), 'unknown')`;
const NOW_MS = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

function insertTrigger(spec: SyncTableSpec): string {
  return `
CREATE TRIGGER IF NOT EXISTS sync_${spec.name}_ai AFTER INSERT ON \`${spec.name}\`
BEGIN
  INSERT INTO sync_oplog (table_name, row_id, op, wall_ms, device_id, changed_fields)
  VALUES ('${spec.name}', NEW.\`${spec.pk}\`, 'insert', ${NOW_MS}, ${WRITE_AS}, NULL);
END;`;
}

function deleteTrigger(spec: SyncTableSpec): string {
  return `
CREATE TRIGGER IF NOT EXISTS sync_${spec.name}_ad AFTER DELETE ON \`${spec.name}\`
BEGIN
  INSERT INTO sync_oplog (table_name, row_id, op, wall_ms, device_id, changed_fields)
  VALUES ('${spec.name}', OLD.\`${spec.pk}\`, 'delete', ${NOW_MS}, ${WRITE_AS}, NULL);
END;`;
}

function updateTrigger(spec: SyncTableSpec): string {
  const tracked = spec.columns.filter((c) => c !== spec.pk);
  const anyChanged = tracked.map((c) => `OLD.\`${c}\` IS NOT NEW.\`${c}\``).join('\n     OR ');
  const fieldList = tracked
    .map((c) => `CASE WHEN OLD.\`${c}\` IS NOT NEW.\`${c}\` THEN ',"${c}"' ELSE '' END`)
    .join('\n      || ');

  return `
CREATE TRIGGER IF NOT EXISTS sync_${spec.name}_au AFTER UPDATE ON \`${spec.name}\`
WHEN ${anyChanged}
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

function buildTriggerSql(spec: SyncTableSpec): string[] {
  return [insertTrigger(spec), updateTrigger(spec), deleteTrigger(spec)];
}

export function installSyncTriggers(raw: SQLiteDatabase): void {
  const specs = syncTableSpecs();
  raw.execSync('BEGIN');
  try {
    for (const spec of specs) {
      for (const suffix of ['ai', 'au', 'ad']) {
        raw.execSync(`DROP TRIGGER IF EXISTS sync_${spec.name}_${suffix};`);
      }
      for (const sql of buildTriggerSql(spec)) {
        raw.execSync(sql);
      }
    }
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
