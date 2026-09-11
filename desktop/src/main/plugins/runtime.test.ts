/**
 * Campaign 运行时读写。
 *
 * 关键约束：依赖解析只在写入路径发生一次，读视图路径一行都不写。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { CORE_CAPABILITIES_PACK_ID, CORE_CAPABILITIES_PACK_VERSION } from '@core/plugins/capabilitySuite';
import { listBuiltInPlugins } from '@core/plugins/clientView';
import {
  builtInPluginKeys,
  getCampaignRuntime,
  getClientCapabilityView,
  listInstalledPlugins,
  setCampaignRoleProfile,
  setExternalPlugins,
} from './runtime';
import { installRolePacks, installedRolePackEntry } from './__fixtures__/installedPlugins';
import type { PluginInventoryEntry } from './inventory';
import type { RolePack } from '@core/plugins/types';
import { installSyncTriggers } from '../sync/triggers';

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');
const ROLE_PACK_ID = softwareEngineeringRolePack.manifest.id;
const ROLE_PACK_VERSION = softwareEngineeringRolePack.manifest.version;
const REPO_ID = CORE_CAPABILITIES_PACK_ID;
const EXTERNAL_ROLE_PACK_ID = 'demo.role';

/**
 * 一个必然合法的外置岗位包：拿内置包改 id/version。
 *
 * 用真实内置包做底子而不是手写夹具，是为了让「外置」成为唯一变量——夹具写歪了会
 * 把契约问题伪装成装载问题。
 */
function externalRolePack(id = EXTERNAL_ROLE_PACK_ID, version = '2.0.0'): RolePack {
  const source = structuredClone(softwareEngineeringRolePack) as RolePack;
  return {
    ...source,
    manifest: { ...source.manifest, id, version, dependencies: [] },
  };
}

function externalEntry(pack: RolePack): PluginInventoryEntry {
  return {
    dir: `/tmp/${pack.manifest.id}@${pack.manifest.version}`,
    trust: 'first-party',
    package: { manifest: pack.manifest, rolePack: pack },
  };
}

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
  afterEach(() => {
    setExternalPlugins([]);
  });

  it('什么都没装时清单为空：基础包不自带任何插件', () => {
    // 能力已并入单独安装的合编包（openjob-capabilities），内置清单清空；
    // 出厂状态下练习链路就该是「还没选岗位」，能力也还没有
    expect(listInstalledPlugins()).toEqual(listBuiltInPlugins());
    expect(listInstalledPlugins()).toEqual([]);
    expect(listInstalledPlugins().map((plugin) => plugin.id)).not.toContain(ROLE_PACK_ID);
  });

  it('装了外置岗位包之后清单不再等于内置清单', () => {
    setExternalPlugins([externalEntry(externalRolePack())]);

    const ids = listInstalledPlugins().map((plugin) => plugin.id);

    expect(ids).toContain(EXTERNAL_ROLE_PACK_ID);
    expect(listInstalledPlugins()).not.toEqual(listBuiltInPlugins());
  });

  it('清单按 id、version 稳定排序，与注入顺序无关', () => {
    const first = externalRolePack('aaa.role');
    const second = externalRolePack('zzz.role');

    setExternalPlugins([externalEntry(second), externalEntry(first)]);
    const forward = listInstalledPlugins();
    setExternalPlugins([externalEntry(first), externalEntry(second)]);

    expect(listInstalledPlugins()).toEqual(forward);
  });

  it('builtInPluginKeys 是退役名册：三个旧能力 id@1.0.0 不被外置包顶替', () => {
    const keys = builtInPluginKeys();

    expect(keys.has('source-repository@1.0.0')).toBe(true);
    expect(keys.has('role-play@1.0.0')).toBe(true);
    expect(keys.has('analytics-case@1.0.0')).toBe(true);
    expect(keys.size).toBe(3);
    expect(listBuiltInPlugins()).toEqual([]);
  });

  it('岗位包的 id@version 不被占用，官方包才装得进来', () => {
    // 官方岗位包正是以 software-engineering@1.0.0 这个 id@version 分发的。占住它的后果不是
    // 报错，而是用户从 release 下载的岗位包一律以 reserved-id 被拒——而拒绝理由指向
    // 「与随应用发布的插件冲突」，而基础包里根本没有这个插件
    expect(builtInPluginKeys().has(`${ROLE_PACK_ID}@${ROLE_PACK_VERSION}`)).toBe(false);
  });
});

describe('外置岗位包参与解析', () => {
  let raw: Database;

  beforeEach(() => {
    raw = freshDb();
  });

  afterEach(() => {
    setExternalPlugins([]);
  });

  it('装载后可以被 Campaign 选中并写出 descriptor', () => {
    setExternalPlugins([externalEntry(externalRolePack())]);

    const view = setCampaignRoleProfile(
      raw,
      { campaignId: 'c1', roleFamily: 'design', rolePackId: EXTERNAL_ROLE_PACK_ID },
      { now: () => 1234 },
    );

    expect(view.descriptor.rolePack).toEqual({ id: EXTERNAL_ROLE_PACK_ID, version: '2.0.0' });
    expect(bindings(raw).map((row) => row.plugin_id)).toContain(EXTERNAL_ROLE_PACK_ID);
  });

  it('卸载后同一个岗位包解析失败，已写出的 descriptor 不受影响', () => {
    setExternalPlugins([externalEntry(externalRolePack())]);
    const before = setCampaignRoleProfile(
      raw,
      { campaignId: 'c1', roleFamily: 'design', rolePackId: EXTERNAL_ROLE_PACK_ID },
      { now: () => 1234 },
    );

    setExternalPlugins([]);

    expect(() =>
      setCampaignRoleProfile(
        raw,
        { campaignId: 'c1', roleFamily: 'design', rolePackId: EXTERNAL_ROLE_PACK_ID },
        { now: () => 2345 },
      ),
    ).toThrow();
    // descriptor 是既成事实：插件卸载不该回溯改写已经解析过的运行时
    expect(getCampaignRuntime(raw, 'c1')?.descriptor).toEqual(before.descriptor);
  });

  it('内容相同、id 不同的两个岗位包解析出同一个能力基线', () => {
    // 基线只看解析出来的配置内容，不看包是从哪个目录装进来的；否则同一份岗位包换个
    // 分发渠道就会算出另一份基线，跨端比对直接失效
    const clone = structuredClone(softwareEngineeringRolePack) as RolePack;
    clone.manifest = { ...clone.manifest, id: 'clone.role', version: ROLE_PACK_VERSION };
    setExternalPlugins([
      installedRolePackEntry(softwareEngineeringRolePack),
      externalEntry(clone),
    ]);

    const official = setCampaignRoleProfile(
      raw,
      { campaignId: 'c1', roleFamily: 'software', rolePackId: ROLE_PACK_ID },
      { now: () => 1 },
    );
    const cloned = setCampaignRoleProfile(
      raw,
      { campaignId: 'c1', roleFamily: 'software', rolePackId: 'clone.role' },
      { now: () => 2 },
    );

    expect(cloned.descriptor.competencyBaselineVersion).toBe(
      official.descriptor.competencyBaselineVersion,
    );
  });
});

describe('setCampaignRoleProfile', () => {
  let raw: Database;

  beforeEach(() => {
    raw = freshDb();
    // 岗位包由用户安装：不装的话这一组用例全部停在 plugin-not-found，测不到写入路径
    installRolePacks();
  });

  afterEach(() => {
    setExternalPlugins([]);
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
    // SE 包 1.1.0 的可选依赖指向能力合编包，resolver 展开为它的精确版本
    expect(view.descriptor.capabilities).toEqual([
      { id: CORE_CAPABILITIES_PACK_ID, version: '1.0.0', enabled: true },
    ]);
    expect(view.roleProfile).toMatchObject({
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
      interviewLanguage: 'zh',
      userConfirmed: true,
    });
    // resolver 先写 capabilities 再写岗位包（见 runtime.ts 的 bound 顺序）
    expect(bindings(raw)).toEqual([
      { plugin_id: REPO_ID, plugin_version: CORE_CAPABILITIES_PACK_VERSION, revision: 1, active_execution: 1 },
      {
        plugin_id: ROLE_PACK_ID,
        plugin_version: ROLE_PACK_VERSION,
        revision: 1,
        active_execution: 1,
      },
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

    // 刻意用一个不会被实现的 ID：换成计划中的岗位包，等它发布这条用例就会静默失效
    expect(() =>
      setCampaignRoleProfile(raw, {
        campaignId: 'c1',
        roleFamily: 'product',
        rolePackId: 'not-installed-role-pack',
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
    installRolePacks();
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

  afterEach(() => {
    setExternalPlugins([]);
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
