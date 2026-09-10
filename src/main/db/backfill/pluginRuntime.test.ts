import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_CAMPAIGN_SCOPE_KIND } from '@shared/planner/contributions';
import {
  PLUGIN_RUNTIME_BACKFILL_KIND,
  backfillLegacyCampaignPluginRuntime,
} from './pluginRuntime';
import { applyMigrations, newLegacyDb } from '../__fixtures__/legacyDb';
import { installSyncTriggers } from '../../sync/triggers';

/** 插件运行时迁移之前的最后一条：旧库就停在这里，Campaign 要在这个 schema 上先存在。 */
const PRE_PLUGIN_MIGRATION = '0022_campaign_resume_backfill';

/**
 * 把库补齐到当前 schema。
 *
 * 0027_legacy_campaign_scope 会在这一步把「此刻还没有岗位意图」的 Campaign 标记成
 * 旧数据，也就是回填唯一认的那批。顺序刻意与生产一致（先迁移，再装同步触发器，
 * 最后回填），否则迁移期的写入会被记进 sync_oplog，和线上行为就不是一回事了。
 */
function upgradeToPluginSchema(raw: Database): void {
  applyMigrations(raw, { after: PRE_PLUGIN_MIGRATION });
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

/** checkpoint 表里混着「旧数据凭据」和「回填已完成」两种行，按 kind 数才说明问题 */
function countKind(raw: Database, kind: string): number {
  return (
    raw.prepare(`SELECT count(*) AS n FROM migration_checkpoint WHERE kind = ?`).get(kind) as {
      n: number;
    }
  ).n;
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
    raw = newLegacyDb({ through: PRE_PLUGIN_MIGRATION });
  });

  it('在单事务中写入 profile、binding、descriptor、关联和 checkpoint', () => {
    seedCampaign(raw, 'c1');
    seedCampaign(raw, 'c2');
    upgradeToPluginSchema(raw);
    installTracking(raw);

    const report = backfillLegacyCampaignPluginRuntime(raw, { now: () => 1234 });

    expect(report).toEqual({ completed: 2, failures: [] });
    expect(count(raw, 'role_profile')).toBe(2);
    expect(count(raw, 'campaign_plugin_binding')).toBe(4);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(2);
    expect(countKind(raw, PLUGIN_RUNTIME_BACKFILL_KIND)).toBe(2);
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
    upgradeToPluginSchema(raw);
    expect(backfillLegacyCampaignPluginRuntime(raw).completed).toBe(1);

    const second = backfillLegacyCampaignPluginRuntime(raw);
    expect(second).toEqual({ completed: 0, failures: [] });
    expect(count(raw, 'role_profile')).toBe(1);
    expect(count(raw, 'campaign_plugin_binding')).toBe(2);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(1);
    expect(countKind(raw, PLUGIN_RUNTIME_BACKFILL_KIND)).toBe(1);
  });

  /**
   * 这是「打出来的包还是面向软件工程师」的根因：新建 Campaign 的 role_profile_id
   * 同样是 NULL，回填原本只按这个条件选人，于是还没选岗位的新战役会在下次启动被
   * 盖成工程岗 + source-repository，Repos 页跟着冒出来。
   */
  it('迁移之后新建的 Campaign 不在旧数据集合里，不会被盖成工程岗', () => {
    seedCampaign(raw, 'legacy');
    upgradeToPluginSchema(raw);
    seedCampaign(raw, 'fresh');

    expect(backfillLegacyCampaignPluginRuntime(raw)).toEqual({ completed: 1, failures: [] });

    expect(
      raw.prepare(`SELECT role_pack_id FROM role_profile`).all(),
    ).toEqual([{ role_pack_id: 'software-engineering' }]);
    expect(
      raw.prepare(`SELECT role_profile_id FROM campaign WHERE id = 'fresh'`).get(),
    ).toEqual({ role_profile_id: null });
    expect(
      raw.prepare(`SELECT count(*) AS n FROM campaign_plugin_binding WHERE campaign_id = 'fresh'`).get(),
    ).toEqual({ n: 0 });
  });

  it('checkpoint 前失败会整笔回滚，并可在下次安全重试', () => {
    seedCampaign(raw, 'c1');
    upgradeToPluginSchema(raw);
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
    ]) {
      expect(count(raw, table), table).toBe(0);
    }
    expect(countKind(raw, PLUGIN_RUNTIME_BACKFILL_KIND)).toBe(0);
    // 旧数据凭据由迁移写下，不属于这笔事务：回滚掉它，下次就再也认不出这是旧战役了
    expect(countKind(raw, LEGACY_CAMPAIGN_SCOPE_KIND)).toBe(1);
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
