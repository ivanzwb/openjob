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

/**
 * 行版本触发器：维护每一行最后一次更新的时间，后写覆盖靠它判新旧。
 *
 * 和 oplog 触发器相反，这三个**不**带 isLocalWrite 判断——应用对端数据时
 * 也要更新版本，否则从对端同步进来的行永远没有时间可比。落库后
 * applyAutoChanges 会把版本改写成来源端的时间，覆盖掉这里写的当前时间。
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
  return [
    insertTrigger(spec, localDeviceId),
    updateTrigger(spec, localDeviceId),
    deleteTrigger(spec, localDeviceId),
    ...rowVersionTriggerSql(spec),
  ];
}

/**
 * 给存量数据补上行版本。
 *
 * 新装的库靠触发器就够了，但已经在用的库里几万行都没有版本时间。缺时间的
 * 行在后写覆盖里会被当成"最老"，第一次同步就可能被对端整体压掉，所以必须
 * 用现有信息尽量还原：oplog 里的最后一次改动时间最准，其次是业务表自己的
 * updated_at / created_at。
 *
 * 只跑一次，之后交给触发器。
 */
export function backfillRowVersions(raw: Database): void {
  const done = raw
    .prepare(`SELECT value FROM sync_meta WHERE key = 'rowVersionBackfilledAt'`)
    .get() as { value: string } | undefined;
  if (done) return;

  raw.transaction(() => {
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
      raw.exec(`
        INSERT INTO sync_row_version (table_name, row_id, updated_ms)
        SELECT '${spec.name}', t.\`${spec.pk}\`, coalesce(${fallbacks.join(', ')})
        FROM \`${spec.name}\` t
        WHERE true
        ON CONFLICT(table_name, row_id) DO NOTHING;
      `);
    }

    raw
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES ('rowVersionBackfilledAt', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(Date.now()));
  })();
}

/**
 * 安装/重建全部同步触发器。
 *
 * 每次启动都先 DROP 再 CREATE：schema 演进后列集合会变，旧触发器里的列
 * 清单是过时的，留着会漏采字段。重建成本可以忽略。
 *
 * 同时清理清单外表的残留：表从同步清单移除后，旧触发器不会自动消失，
 * 仍会往 sync_oplog 写记录，collect 时 syncTableSpec 会抛「表不在同步清单
 * 里」导致同步中断。启动时把清单外表的触发器和 oplog 残留一并清掉，自愈。
 */
export function installSyncTriggers(raw: Database, localDeviceId: string): void {
  const specs = syncTableSpecs();
  const known = new Set(specs.map((s) => s.name));

  raw.transaction(() => {
    // 清理清单外表的残留触发器（如曾被移出清单的 search_cache）
    const triggers = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .all() as { name: string }[];
    for (const { name } of triggers) {
      const m = /^(?:sync|syncrv)_(.+)_(?:ai|au|ad)$/.exec(name);
      if (m && !known.has(m[1])) {
        raw.exec(`DROP TRIGGER IF EXISTS ${name};`);
      }
    }

    for (const spec of specs) {
      for (const prefix of ['sync', 'syncrv']) {
        for (const suffix of ['ai', 'au', 'ad']) {
          raw.exec(`DROP TRIGGER IF EXISTS ${prefix}_${spec.name}_${suffix};`);
        }
      }
      for (const sql of buildTriggerSql(spec, localDeviceId)) {
        raw.exec(sql);
      }
    }

    // 清掉清单外表的残留，collect/apply 不再读到未知表
    const placeholders = specs.map(() => '?').join(', ');
    const names = specs.map((s) => s.name);
    raw.prepare(`DELETE FROM sync_oplog WHERE table_name NOT IN (${placeholders})`).run(...names);
    raw
      .prepare(`DELETE FROM sync_row_version WHERE table_name NOT IN (${placeholders})`)
      .run(...names);
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
