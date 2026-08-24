/**
 * 应用对端变更时的外键安全测试。
 *
 * planMerge 是逐行独立决策的：同一批变更里完全可能出现「insert 新建父行 +
 * patch 把已有子行改挂到这个新父」。应用侧必须保证 patch 执行时它引用的
 * 父行已经存在——foreign_keys = ON 下 SQLite 是逐语句立即检查外键的，
 * 顺序错了就是 FOREIGN KEY constraint failed，整批事务回滚。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAutoChanges } from './apply';
import { installSyncTriggers } from './triggers';

const LOCAL_DEVICE = 'device-local';
const PEER_DEVICE = 'device-peer';

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

/** 与 rowVersion.test.ts 相同的 node:sqlite 适配层 */
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

function seedCampaign(raw: Database, id = 'c1'): void {
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, 'ACME', 'SRE', 'jd', 'planning', 1, 1)`,
    )
    .run(id);
}

function insertNode(raw: Database, id: string, name: string): void {
  raw
    .prepare(
      `INSERT INTO knowledge_node (id, campaign_id, name, kind, coverage_type, created_at)
       VALUES (?, 'c1', ?, 'concept', 'core', ?)`,
    )
    .run(id, name, Date.now());
}

function readyDb(): Database {
  const raw = freshDb();
  installSyncTriggers(raw, LOCAL_DEVICE);
  seedCampaign(raw);
  return raw;
}

describe('应用变更的外键安全', () => {
  let raw: Database;

  beforeEach(() => {
    raw = readyDb();
  });

  it('patch 改挂到同批 insert 的新父行——patch 必须等父行落库后再执行', () => {
    insertNode(raw, 'n1', 'TCP');

    // 对端新建了 campaign c2，并把 n1 挂了过去。planMerge 逐行独立，
    // 这两条会出现在同一批变更里。
    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        {
          table: 'knowledge_node',
          rowId: 'n1',
          kind: 'patch',
          values: { campaign_id: 'c2' },
          wallMs: 2000,
        },
        {
          table: 'campaign',
          rowId: 'c2',
          kind: 'insert',
          values: {
            company: 'NEWCO',
            role_title: 'Backend',
            jd_raw: 'jd',
            status: 'planning',
            created_at: 1000,
            updated_at: 1000,
          },
          wallMs: 1000,
        },
      ]),
    ).not.toThrow();

    const row = raw.prepare(`SELECT campaign_id FROM knowledge_node WHERE id = 'n1'`).get() as {
      campaign_id: string;
    };
    expect(row.campaign_id).toBe('c2');
  });

  it('insert 仍然父表在前——子行随父行同批到达时能整批落库', () => {
    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        {
          table: 'knowledge_node',
          rowId: 'n9',
          kind: 'insert',
          values: {
            campaign_id: 'c2',
            name: 'QUIC',
            kind: 'concept',
            coverage_type: 'core',
            created_at: 1000,
          },
          wallMs: 2000,
        },
        {
          table: 'campaign',
          rowId: 'c2',
          kind: 'insert',
          values: {
            company: 'NEWCO',
            role_title: 'Backend',
            jd_raw: 'jd',
            status: 'planning',
            created_at: 1000,
            updated_at: 1000,
          },
          wallMs: 1000,
        },
      ]),
    ).not.toThrow();

    const n = raw.prepare(`SELECT count(*) AS n FROM knowledge_node WHERE id = 'n9'`).get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it('delete 仍然子表在前——删父行前先清掉引用它的子行', () => {
    insertNode(raw, 'n1', 'TCP');
    installSyncTriggers(raw, LOCAL_DEVICE);

    expect(() =>
      applyAutoChanges(raw, PEER_DEVICE, [
        { table: 'campaign', rowId: 'c1', kind: 'delete', values: {}, wallMs: 3000 },
        { table: 'knowledge_node', rowId: 'n1', kind: 'delete', values: {}, wallMs: 3000 },
      ]),
    ).not.toThrow();

    const n = raw.prepare(`SELECT count(*) AS n FROM knowledge_node`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});
