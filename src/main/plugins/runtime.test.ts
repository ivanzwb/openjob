/**
 * Campaign 运行时读写。
 *
 * 关键约束：依赖解析只在写入路径发生一次，读视图路径一行都不写。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { softwareEngineeringRolePack } from '@shared/plugins/builtin/softwareEngineering';
import { sourceRepositoryCapabilityPlugin } from '@shared/plugins/builtin/sourceRepository';
import { listBuiltInPlugins } from '@shared/plugins/clientView';
import {
  getCampaignRuntime,
  getClientCapabilityView,
  listInstalledPlugins,
  setCampaignRoleProfile,
} from './runtime';
import { installSyncTriggers } from '../sync/triggers';

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');
const ROLE_PACK_ID = softwareEngineeringRolePack.manifest.id;
const ROLE_PACK_VERSION = softwareEngineeringRolePack.manifest.version;
const REPO_ID = sourceRepositoryCapabilityPlugin.manifest.id;

/** 与 db/backfill/pluginRuntime.test.ts 相同的 node:sqlite 适配层 */
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

function freshDb(): Database {
  const raw = adapt(new DatabaseSync(':memory:'));
  raw.exec('PRAGMA foreign_keys = ON');
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .forEach((file) => {
      readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
        .split('--> statement-breakpoint')
        .forEach((statement) => {
          if (statement.trim()) raw.exec(statement);
        });
    });
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES ('c1', 'ACME', 'Backend Engineer', 'JD', 'planning', 1, 1)`,
    )
    .run();
  return raw;
}

function count(raw: Database, table: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function bindings(raw: Database): Array<{
  plugin_id: string;
  plugin_version: string;
  revision: number;
  active_execution: number;
}> {
  return raw
    .prepare(
      `SELECT plugin_id, plugin_version, revision, active_execution
       FROM campaign_plugin_binding ORDER BY revision, plugin_id`,
    )
    .all() as never;
}

describe('listInstalledPlugins', () => {
  it('返回随应用发布的内置插件，与共享清单一致', () => {
    expect(listInstalledPlugins()).toEqual(listBuiltInPlugins());
    expect(listInstalledPlugins().map((plugin) => plugin.id)).toContain(ROLE_PACK_ID);
    expect(listInstalledPlugins().map((plugin) => plugin.id)).toContain(REPO_ID);
  });
});

describe('setCampaignRoleProfile', () => {
  let raw: Database;

  beforeEach(() => {
    raw = freshDb();
  });

  it('首次写入 profile、binding 与 descriptor，并展开岗位包的可选依赖', () => {
    const view = setCampaignRoleProfile(
      raw,
      { campaignId: 'c1', roleFamily: 'software', rolePackId: ROLE_PACK_ID },
      { now: () => 1234 },
    );

    expect(view.revision).toBe(1);
    expect(view.descriptor).toMatchObject({
      campaignId: 'c1',
      rolePack: { id: ROLE_PACK_ID, version: ROLE_PACK_VERSION },
      resolvedAt: 1234,
    });
    expect(view.descriptor.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(view.descriptor.capabilities).toEqual([
      { id: REPO_ID, version: sourceRepositoryCapabilityPlugin.manifest.version, enabled: true },
    ]);
    expect(view.roleProfile).toMatchObject({
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
      interviewLanguage: 'zh',
      userConfirmed: true,
    });
    expect(bindings(raw)).toEqual([
      {
        plugin_id: ROLE_PACK_ID,
        plugin_version: ROLE_PACK_VERSION,
        revision: 1,
        active_execution: 1,
      },
      { plugin_id: REPO_ID, plugin_version: '1.0.0', revision: 1, active_execution: 1 },
    ]);
  });

  it('再次设置生成新 revision，旧 binding 只停用不删除', () => {
    setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
    });
    const second = setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
      level: 'senior',
      userConfirmed: false,
    });

    expect(second.revision).toBe(2);
    expect(second.roleProfile).toMatchObject({ level: 'senior', userConfirmed: false });
    // 岗位意图就地更新，不给同一个 Campaign 留两份
    expect(count(raw, 'role_profile')).toBe(1);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(2);
    expect(bindings(raw).map((row) => `${row.revision}:${row.active_execution}`)).toEqual([
      '1:0',
      '1:0',
      '2:1',
      '2:1',
    ]);
  });

  it('解析失败时不写任何一行，Campaign 保留上一份 descriptor', () => {
    setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
    });

    expect(() =>
      setCampaignRoleProfile(raw, {
        campaignId: 'c1',
        roleFamily: 'product',
        rolePackId: 'product-manager',
      }),
    ).toThrow(/plugin-not-found/);

    expect(count(raw, 'campaign_runtime_descriptor')).toBe(1);
    expect(count(raw, 'campaign_plugin_binding')).toBe(2);
    expect(getCampaignRuntime(raw, 'c1')?.roleProfile?.rolePackId).toBe(ROLE_PACK_ID);
  });

  it('Campaign 不存在时直接拒绝', () => {
    expect(() =>
      setCampaignRoleProfile(raw, {
        campaignId: 'missing',
        roleFamily: 'software',
        rolePackId: ROLE_PACK_ID,
      }),
    ).toThrow(/Campaign 不存在/);
    expect(count(raw, 'role_profile')).toBe(0);
  });
});

describe('getClientCapabilityView', () => {
  let raw: Database;

  beforeEach(() => {
    raw = freshDb();
    setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
    });
    raw
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES ('writeAs', 'test-device')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
    installSyncTriggers(raw, 'test-device');
  });

  it('两端消费同一份 descriptor，本机降级不回写绑定', () => {
    const before = bindings(raw);

    const desktop = getClientCapabilityView(raw, { campaignId: 'c1', platform: 'desktop' });
    const mobile = getClientCapabilityView(raw, { campaignId: 'c1', platform: 'mobile' });

    expect(desktop?.enabledCapabilityIds).toEqual([REPO_ID]);
    expect(mobile?.readOnlyCapabilityIds).toEqual([REPO_ID]);
    expect(mobile?.configSnapshotHash).toBe(desktop?.configSnapshotHash);

    expect(bindings(raw)).toEqual(before);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(1);
    expect(count(raw, 'sync_oplog')).toBe(0);
  });

  it('按调用方上报的安装清单计算，桌面不替手机猜能力', () => {
    const view = getClientCapabilityView(raw, {
      campaignId: 'c1',
      platform: 'mobile',
      installed: listBuiltInPlugins().filter((plugin) => plugin.id !== REPO_ID),
    });

    expect(view?.capabilities[0]).toMatchObject({
      id: REPO_ID,
      mode: 'view-only',
      reason: 'plugin-not-installed',
    });
    expect(count(raw, 'sync_oplog')).toBe(0);
  });

  it('还没激活 descriptor 的 Campaign 返回 null，由调用方走旧路径', () => {
    raw
      .prepare(
        `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
         VALUES ('c2', 'ACME', 'PM', 'JD', 'planning', 1, 1)`,
      )
      .run();

    expect(getCampaignRuntime(raw, 'c2')).toBeNull();
    expect(getClientCapabilityView(raw, { campaignId: 'c2', platform: 'mobile' })).toBeNull();
  });
});
