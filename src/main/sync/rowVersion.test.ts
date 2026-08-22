/**
 * 行版本机制的真库测试。
 *
 * 后写覆盖的正确性全押在 sync_row_version 上：时间不准就等于随机挑一边覆盖。
 * 触发器 SQL 和回填 SQL 都是字符串拼出来的，类型检查看不见它们，只能真的
 * 建一个库跑一遍。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAutoChanges } from './apply';
import { collectChangeSet, collectFullChangeSet } from './collect';
import { backfillRowVersions, installSyncTriggers } from './triggers';

const LOCAL_DEVICE = 'device-local';
const PEER_DEVICE = 'device-peer';

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

/**
 * 用 node:sqlite 顶替 better-sqlite3。
 *
 * better-sqlite3 是按 Electron 的 ABI 编译的原生模块，在 vitest 的 node 进程里
 * 加载会直接把进程搞崩。这里要测的是拼出来的 SQL 在真实 SQLite 上的行为，换个
 * 驱动不影响这件事——两者 prepare/exec 语义一致，只需补上 better-sqlite3 独有
 * 的 transaction 与 pragma。
 */
function adapt(db: DatabaseSync): Database {
  const shim = {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[])),
        run: (...args: unknown[]) => stmt.run(...(args as never[])),
      };
    },
    exec: (sql: string) => db.exec(sql),
    pragma: (statement: string) => db.exec(`PRAGMA ${statement}`),
    transaction:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        db.exec('BEGIN');
        try {
          const out = fn(...args);
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    close: () => db.close(),
  };
  return shim as unknown as Database;
}

function freshDb(): Database {
  const raw = adapt(new DatabaseSync(':memory:'));
  raw.pragma('foreign_keys = ON');

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) raw.exec(trimmed);
    }
  }

  raw.prepare(`INSERT INTO sync_meta (key, value) VALUES ('writeAs', ?)`).run(LOCAL_DEVICE);
  return raw;
}

function version(raw: Database, table: string, rowId: string): number | null {
  const row = raw
    .prepare(`SELECT updated_ms FROM sync_row_version WHERE table_name = ? AND row_id = ?`)
    .get(table, rowId) as { updated_ms: number } | undefined;
  return row?.updated_ms ?? null;
}

/** knowledge_node 必须挂在 campaign 上，测试数据先把父行铺好 */
function seedCampaign(raw: Database): void {
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES ('c1', 'ACME', 'SRE', 'jd', 'planning', 1, 1)`,
    )
    .run();
}

function insertNode(raw: Database, id: string, name: string): void {
  raw
    .prepare(
      `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
       VALUES (?, 'c1', ?, 'concept', 'core', ?)`,
    )
    .run(id, name, Date.now());
}

/** 建库 + 装触发器 + 铺好父行 */
function readyDb(): Database {
  const raw = freshDb();
  installSyncTriggers(raw, LOCAL_DEVICE);
  seedCampaign(raw);
  return raw;
}

describe('sync_row_version 触发器', () => {
  let raw: Database;

  beforeEach(() => {
    raw = readyDb();
  });

  it('插入业务行时记下版本时间', () => {
    const before = Date.now();
    insertNode(raw, 'n1', 'TCP');
    const v = version(raw, 'knowledge_node', 'n1');
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(before - 1000);
    expect(v!).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('更新推进版本时间', () => {
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`UPDATE sync_row_version SET updated_ms = 1000 WHERE row_id = 'n1'`).run();
    raw.prepare(`UPDATE knowledge_node SET name = 'TLS' WHERE id = 'n1'`).run();
    expect(version(raw, 'knowledge_node', 'n1')!).toBeGreaterThan(1000);
  });

  it('值没变的 UPDATE 不推进版本时间', () => {
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`UPDATE sync_row_version SET updated_ms = 1000 WHERE row_id = 'n1'`).run();
    raw.prepare(`UPDATE knowledge_node SET name = 'TCP' WHERE id = 'n1'`).run();
    expect(version(raw, 'knowledge_node', 'n1')).toBe(1000);
  });

  it('删除行时清掉版本记录', () => {
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`DELETE FROM knowledge_node WHERE id = 'n1'`).run();
    expect(version(raw, 'knowledge_node', 'n1')).toBeNull();
  });

  it('外键级联删除也清掉版本记录', () => {
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`DELETE FROM campaign WHERE id = 'c1'`).run();
    expect(version(raw, 'knowledge_node', 'n1')).toBeNull();
  });

  it('应用对端数据时也记版本——这类写入不进 oplog，只有这张表能给出时间', () => {
    applyAutoChanges(raw, PEER_DEVICE, [
      {
        table: 'knowledge_node',
        rowId: 'n9',
        kind: 'insert',
        values: {
          campaign_id: 'c1',
          name: 'QUIC',
          kind: 'concept',
          coverage_type: 'core',
          created_at: 1,
        },
        wallMs: 424242,
      },
    ]);

    const oplog = raw.prepare(`SELECT count(*) AS n FROM sync_oplog WHERE row_id = 'n9'`).get() as {
      n: number;
    };
    expect(oplog.n).toBe(0);
    // 版本记的是来源端的时间，而不是本机“刚写入”的时间
    expect(version(raw, 'knowledge_node', 'n9')).toBe(424242);
  });

  it('patch 同样按来源时间盖版本', () => {
    insertNode(raw, 'n1', 'TCP');
    applyAutoChanges(raw, PEER_DEVICE, [
      {
        table: 'knowledge_node',
        rowId: 'n1',
        kind: 'patch',
        values: { name: 'TLS' },
        wallMs: 555000,
      },
    ]);
    expect(version(raw, 'knowledge_node', 'n1')).toBe(555000);
  });
});

describe('collect 报出的时间', () => {
  let raw: Database;

  beforeEach(() => {
    raw = readyDb();
  });

  it('全量与增量对同一行报出同一个时间', () => {
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`UPDATE sync_row_version SET updated_ms = 777000 WHERE row_id = 'n1'`).run();

    const incremental = collectChangeSet(raw, LOCAL_DEVICE, 0);
    const full = collectFullChangeSet(raw, LOCAL_DEVICE);

    expect(incremental.rows.find((r) => r.rowId === 'n1')?.wallMs).toBe(777000);
    expect(full.rows.find((r) => r.rowId === 'n1')?.wallMs).toBe(777000);
  });

  it('全量快照不再给所有行盖上“现在”', () => {
    insertNode(raw, 'n1', 'TCP');
    insertNode(raw, 'n2', 'UDP');
    raw.prepare(`UPDATE sync_row_version SET updated_ms = 100 WHERE row_id = 'n1'`).run();
    raw.prepare(`UPDATE sync_row_version SET updated_ms = 200 WHERE row_id = 'n2'`).run();

    const full = collectFullChangeSet(raw, LOCAL_DEVICE);
    expect(full.rows.find((r) => r.rowId === 'n1')?.wallMs).toBe(100);
    expect(full.rows.find((r) => r.rowId === 'n2')?.wallMs).toBe(200);
  });

  it('全量快照带上业务列，且不含内部的版本列', () => {
    insertNode(raw, 'n1', 'TCP');
    const row = collectFullChangeSet(raw, LOCAL_DEVICE).rows.find((r) => r.rowId === 'n1');
    expect(row?.values.name).toBe('TCP');
    expect(row?.values).not.toHaveProperty('__updated_ms');
    expect(row?.values).not.toHaveProperty('updated_ms');
  });
});

describe('存量库回填', () => {
  it('用 oplog 的最后改动时间补版本', () => {
    const raw = readyDb();
    insertNode(raw, 'n1', 'TCP');

    // 模拟升级前的库：有 oplog，但没有行版本
    raw.prepare(`DELETE FROM sync_row_version`).run();
    raw.prepare(`UPDATE sync_oplog SET wall_ms = 123456 WHERE row_id = 'n1'`).run();

    backfillRowVersions(raw);
    expect(version(raw, 'knowledge_node', 'n1')).toBe(123456);
  });

  it('没有 oplog 时退回业务表的 updated_at', () => {
    const raw = readyDb();
    raw
      .prepare(
        `INSERT INTO job_target (id, company, role_title, jd_raw, created_at, updated_at)
         VALUES ('j1', 'ACME', 'SRE', 'jd', 1, 999000)`,
      )
      .run();

    raw.prepare(`DELETE FROM sync_row_version`).run();
    raw.prepare(`DELETE FROM sync_oplog`).run();

    backfillRowVersions(raw);
    expect(version(raw, 'job_target', 'j1')).toBe(999000);
  });

  it('既无 oplog 也无 updated_at 时退回 created_at', () => {
    const raw = readyDb();
    raw
      .prepare(
        `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
         VALUES ('n1', 'c1', 'TCP', 'concept', 'core', 888000)`,
      )
      .run();

    raw.prepare(`DELETE FROM sync_row_version`).run();
    raw.prepare(`DELETE FROM sync_oplog`).run();

    backfillRowVersions(raw);
    expect(version(raw, 'knowledge_node', 'n1')).toBe(888000);
  });

  it('已有版本的行不被回填覆盖', () => {
    const raw = readyDb();
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`UPDATE sync_row_version SET updated_ms = 42 WHERE row_id = 'n1'`).run();
    raw.prepare(`UPDATE sync_oplog SET wall_ms = 999999 WHERE row_id = 'n1'`).run();

    backfillRowVersions(raw);
    expect(version(raw, 'knowledge_node', 'n1')).toBe(42);
  });

  it('每张同步表都被扫到，一行不漏', () => {
    const raw = readyDb();
    insertNode(raw, 'n1', 'TCP');
    raw.prepare(`DELETE FROM sync_row_version`).run();

    backfillRowVersions(raw);
    // campaign 与 knowledge_node 各一行
    const n = raw.prepare(`SELECT count(*) AS n FROM sync_row_version`).get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('只跑一次：第二次调用不再改动已有数据', () => {
    const raw = readyDb();
    insertNode(raw, 'n1', 'TCP');
    backfillRowVersions(raw);

    raw.prepare(`DELETE FROM sync_row_version`).run();
    backfillRowVersions(raw);
    expect(version(raw, 'knowledge_node', 'n1')).toBeNull();
  });
});

describe('迁移后的结构', () => {
  it('sync_conflict 已改名为 sync_overwrite，冲突计数改名为覆盖计数', () => {
    const raw = freshDb();
    const names = (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(names).toContain('sync_overwrite');
    expect(names).toContain('sync_row_version');
    expect(names).not.toContain('sync_conflict');

    const runCols = (raw.prepare(`PRAGMA table_info(sync_run)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(runCols).toContain('overwrite_count');
    expect(runCols).not.toContain('conflict_count');

    const owCols = (
      raw.prepare(`PRAGMA table_info(sync_overwrite)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(owCols).toContain('kept_side');
    expect(owCols).not.toContain('resolution');

    const peerCols = (raw.prepare(`PRAGMA table_info(sync_peer)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(peerCols).toContain('last_full_sync_at');
  });
});
