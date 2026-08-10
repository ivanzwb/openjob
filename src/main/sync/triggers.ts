import type { Database } from 'better-sqlite3';
import { syncTableSpecs, type SyncTableSpec } from './tables';

/**
 * 变更采集靠 SQLite 触发器，不靠在业务代码里埋点。
 *
 * 全库有四十多处写入散落在各 service 里，逐处改写既容易漏，也会让每个
 * 模块都被同步逻辑污染。触发器把这件事收敛到一个地方，而且能捕获到
 * 业务代码根本看不见的写入——比如外键级联删除。
 */

/** 触发器写日志时使用的设备身份；应用对端变更期间会被临时改写 */
const WRITE_AS = `coalesce((SELECT value FROM sync_meta WHERE key = 'writeAs'), 'unknown')`;

/**
 * 只有当写入者是本机时才记 oplog。
 * 应用对端变更时 writingAs() 把 writeAs 改成对端 id，触发器看到不等于
 * 本机 id 就跳过——否则应用回来的数据会再写一条 oplog，被当成"本机
 * 新变更"推回来源设备，形成每轮同步都互推回声、水位永久追不上的循环。
 */
function isLocalWrite(localDeviceId: string): string {
  return `(SELECT value FROM sync_meta WHERE key = 'writeAs') = '${localDeviceId}'`;
}

/** unixepoch('subsec') 返回带小数的秒，乘 1000 得到毫秒 */
const NOW_MS = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

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

  // IS NOT 是 SQLite 的 null 安全比较，NULL IS NOT NULL 为假，
  // 用 <> 的话任何一侧为 NULL 都得不到期望结果。
  const anyChanged = tracked.map((c) => `OLD.\`${c}\` IS NOT NEW.\`${c}\``).join('\n     OR ');

  // 没有 filter 能力，只能拼字符串再补方括号：
  // 每个变化的列贡献 ',"col"'，最后去掉头一个逗号。全都没变时得到 '[]'。
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

export function buildTriggerSql(spec: SyncTableSpec, localDeviceId: string): string[] {
  return [insertTrigger(spec, localDeviceId), updateTrigger(spec, localDeviceId), deleteTrigger(spec, localDeviceId)];
}

/**
 * 安装/重建全部同步触发器。
 *
 * 每次启动都先 DROP 再 CREATE：schema 演进后列集合会变，旧触发器里的列
 * 清单是过时的，留着会漏采字段。重建成本可以忽略。
 */
export function installSyncTriggers(raw: Database, localDeviceId: string): void {
  const specs = syncTableSpecs();

  raw.transaction(() => {
    for (const spec of specs) {
      for (const suffix of ['ai', 'au', 'ad']) {
        raw.exec(`DROP TRIGGER IF EXISTS sync_${spec.name}_${suffix};`);
      }
      for (const sql of buildTriggerSql(spec, localDeviceId)) {
        raw.exec(sql);
      }
    }
  })();
}

/**
 * 把一段写入标记成来自对端，避免同步应用的变更被当作本机新变更
 * 再推回给来源设备。better-sqlite3 是同步单线程的，不存在交错。
 */
export function writingAs<T>(raw: Database, deviceId: string, fn: () => T): T {
  const previous = (
    raw.prepare(`SELECT value FROM sync_meta WHERE key = 'writeAs'`).get() as
      | { value: string }
      | undefined
  )?.value;

  raw
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(deviceId);

  try {
    return fn();
  } finally {
    if (previous !== undefined) {
      raw.prepare(`UPDATE sync_meta SET value = ? WHERE key = 'writeAs'`).run(previous);
    }
  }
}
