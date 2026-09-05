import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PLUGIN_RUNTIME_BACKFILL_KIND,
  backfillLegacyCampaignPluginRuntime,
} from './pluginRuntime';
import { installSyncTriggers } from '../../sync/triggers';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function adapt(db: DatabaseSync): Database {
  return {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        all: (...args: unknown[]) => statement.all(...(args as never[])),
        get: (...args: unknown[]) => statement.get(...(args as never[])),
        run: (...args: unknown[]) => statement.run(...(args as never[])),
      };
    },
    exec: (sql: string) => db.exec(sql),
    transaction:
      (task: (...args: never[]) => unknown) =>
      (...args: never[]) => {
        db.exec('BEGIN');
        try {
          const result = task(...args);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    close: () => db.close(),
  } as unknown as Database;
}

function applyMigrations(raw: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  files.forEach((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql.split('--> statement-breakpoint').forEach((statement) => {
      if (statement.trim()) raw.exec(statement);
    });
  });
}

function seedCampaign(raw: Database, id: string): void {
  raw
    .prepare(
      `INSERT INTO campaign (
         id, company, role_title, jd_raw, status, created_at, updated_at
       ) VALUES (?, 'ACME', 'Engineer', 'JD', 'planning', 1, 1)`,
    )
    .run(id);
}

function count(raw: Database, table: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function installTracking(raw: Database): void {
  raw
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('writeAs', 'test-device')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run();
  installSyncTriggers(raw, 'test-device');
}

describe('legacy Campaign plugin runtime backfill', () => {
  let raw: Database;

  beforeEach(() => {
    raw = adapt(new DatabaseSync(':memory:'));
    raw.exec('PRAGMA foreign_keys = ON');
    applyMigrations(raw);
  });

  it('在单事务中写入 profile、binding、descriptor、关联和 checkpoint', () => {
    seedCampaign(raw, 'c1');
    seedCampaign(raw, 'c2');
    installTracking(raw);

    const report = backfillLegacyCampaignPluginRuntime(raw, { now: () => 1234 });

    expect(report).toEqual({ completed: 2, failures: [] });
    expect(count(raw, 'role_profile')).toBe(2);
    expect(count(raw, 'campaign_plugin_binding')).toBe(4);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(2);
    expect(count(raw, 'migration_checkpoint')).toBe(2);
    expect(
      raw
        .prepare(`SELECT count(*) AS n FROM campaign WHERE role_profile_id IS NOT NULL`)
        .get(),
    ).toEqual({ n: 2 });

    const hashes = raw
      .prepare(
        `SELECT b.config_snapshot_hash AS binding_hash,
                d.config_snapshot_hash AS descriptor_hash
         FROM campaign_plugin_binding b
         JOIN campaign_runtime_descriptor d
           ON d.campaign_id = b.campaign_id AND d.revision = b.revision
         ORDER BY b.campaign_id`,
      )
      .all() as Array<{ binding_hash: string; descriptor_hash: string }>;
    expect(hashes).toHaveLength(4);
    hashes.forEach((row) => {
      expect(row.binding_hash).toBe(row.descriptor_hash);
      expect(row.binding_hash).toMatch(/^[a-f0-9]{64}$/);
    });
    const changedTables = new Set(
      (
        raw
          .prepare(`SELECT table_name FROM sync_oplog`)
          .all() as Array<{ table_name: string }>
      ).map((row) => row.table_name),
    );
    expect(changedTables).toEqual(
      new Set([
        'role_profile',
        'campaign',
        'campaign_plugin_binding',
        'campaign_runtime_descriptor',
        'migration_checkpoint',
      ]),
    );
  });

  it('checkpoint 使重复执行保持幂等', () => {
    seedCampaign(raw, 'c1');
    expect(backfillLegacyCampaignPluginRuntime(raw).completed).toBe(1);

    const second = backfillLegacyCampaignPluginRuntime(raw);
    expect(second).toEqual({ completed: 0, failures: [] });
    expect(count(raw, 'role_profile')).toBe(1);
    expect(count(raw, 'campaign_plugin_binding')).toBe(2);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(1);
    expect(count(raw, 'migration_checkpoint')).toBe(1);
  });

  it('checkpoint 前失败会整笔回滚，并可在下次安全重试', () => {
    seedCampaign(raw, 'c1');
    installTracking(raw);
    const failed = backfillLegacyCampaignPluginRuntime(raw, {
      beforeCheckpoint: () => {
        throw new Error('injected failure');
      },
    });

    expect(failed).toEqual({
      completed: 0,
      failures: [{ campaignId: 'c1', message: 'injected failure' }],
    });
    for (const table of [
      'role_profile',
      'campaign_plugin_binding',
      'campaign_runtime_descriptor',
      'migration_checkpoint',
    ]) {
      expect(count(raw, table), table).toBe(0);
    }
    expect(
      raw.prepare(`SELECT role_profile_id FROM campaign WHERE id = 'c1'`).get(),
    ).toEqual({ role_profile_id: null });
    expect(count(raw, 'sync_oplog')).toBe(0);

    expect(backfillLegacyCampaignPluginRuntime(raw).completed).toBe(1);
    expect(
      raw
        .prepare(
          `SELECT kind FROM migration_checkpoint WHERE campaign_id = 'c1'`,
        )
        .get(),
    ).toEqual({ kind: PLUGIN_RUNTIME_BACKFILL_KIND });
  });
});
