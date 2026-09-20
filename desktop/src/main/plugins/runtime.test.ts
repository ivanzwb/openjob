/**
 * Campaign 运行时读写。
 *
 * 关键约束：依赖解析只在写入路径发生一次；读视图路径对既没有岗位画像、也没有
 * pre-plugin 凭据的旧战役一行都不写，只有「有画像、没 descriptor」时才补一次解析
 * （见下方「读路径补解析」一组）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { softwareEngineeringRolePack, SOURCE_REPOSITORY_CAPABILITY_ID } from '@plugins/softwareEngineering';
import { listBuiltInPlugins } from '@core/plugins/clientView';
import {
  declaredLlmRole,
  declaredLlmRoles,
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
// 能力随岗位包分发：descriptor 里 pin 的是能力自己的 id
const REPO_ID = SOURCE_REPOSITORY_CAPABILITY_ID;
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
    // 岗位包由用户安装，能力随岗位包的内嵌声明派生——两样都没有；
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

  it('内置清单为空：基础包不自带任何插件，也没有保留名册', () => {
    expect(listBuiltInPlugins()).toEqual([]);
  });
});

describe('岗位包声明的 LLM 角色', () => {
  afterEach(() => {
    setExternalPlugins([]);
  });

  it('装了工程岗位包就能拿到 source-repository 声明的角色', () => {
    setExternalPlugins([externalEntry(softwareEngineeringRolePack)]);

    expect(declaredLlmRole('source-repository')).toBe('codeAgent');
    expect(declaredLlmRoles()).toEqual([
      { role: { name: 'codeAgent', hint: expect.any(String) }, pluginId: ROLE_PACK_ID },
    ]);
  });

  it('什么都没装时拿不到角色——基础包不认识 codeAgent', () => {
    expect(declaredLlmRole('source-repository')).toBeUndefined();
    expect(declaredLlmRoles()).toEqual([]);
  });

  it('只声明了别的能力或别的角色时，不会凭空冒出这个角色', () => {
    const pack = externalRolePack('demo.role');
    pack.capabilities = [
      {
        id: 'source-repository',
        tools: [
          {
            name: 'grep',
            description: 'Search workspace file contents.',
            permission: 'filesystem:workspace',
            inputSchemaVersion: 1,
          },
        ],
      },
    ];
    // 夹具的 manifest 必须与它自己的声明一致（权限并集由 contracts 强制），
    // 否则报的是权限不一致，测不到「角色不会凭空出现」这条
    pack.manifest.permissions = ['filesystem:workspace'];

    setExternalPlugins([externalEntry(pack)]);
    expect(declaredLlmRole('source-repository')).toBeUndefined();
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
    // 能力随岗位包分发：descriptor 里 pin 的是能力自己的 id 与所属包版本
    expect(view.descriptor.capabilities).toEqual([
      { id: REPO_ID, version: ROLE_PACK_VERSION, enabled: true },
    ]);
    expect(view.roleProfile).toMatchObject({
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
      interviewLanguage: 'zh',
      userConfirmed: true,
    });
    // 岗位包与它启用的能力各绑一条（按 plugin_id 排序，见 bindings 的 ORDER BY）
    expect(bindings(raw)).toEqual([
      {
        plugin_id: ROLE_PACK_ID,
        plugin_version: ROLE_PACK_VERSION,
        revision: 1,
        active_execution: 1,
      },
      { plugin_id: REPO_ID, plugin_version: ROLE_PACK_VERSION, revision: 1, active_execution: 1 },
    ]);
  });

  /**
   * 面板按 descriptor 回显能力勾选（draftFromRuntime 取 enabledCapabilityIds），保存时会把
   * 这些 id 原样交回 capabilityIds。能力随岗位包分发、不是可单独安装的包，这份回显不能当成
   * 「要装 source-repository」——否则用户只是改个级别就会撞上 plugin-not-found。
   */
  it('按 descriptor 回填的能力选择不会把内嵌能力当成未安装的插件', () => {
    const first = setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
    });
    const echoed = first.descriptor.capabilities
      .filter((capability) => capability.enabled)
      .map((capability) => capability.id);

    const second = setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'software',
      rolePackId: ROLE_PACK_ID,
      level: 'senior',
      capabilityIds: echoed,
    });

    expect(second.revision).toBe(2);
    expect(second.roleProfile).toMatchObject({ level: 'senior' });
    expect(second.descriptor.capabilities).toEqual([
      { id: REPO_ID, version: ROLE_PACK_VERSION, enabled: true },
    ]);
  });

  /**
   * 行业差异是岗位包内的可选字段，不是另一个要装的包：选项随包进安装清单，选中的键写进
   * 画像与 descriptor；包里没有这个键就降级成「没选」，不报错。
   */
  it('行业差异变体随岗位包声明生效，未声明的降级为不选', () => {
    const pack: RolePack = {
      ...externalRolePack('demo.industry', '1.0.0'),
      industryVariants: [
        { id: 'fintech', displayName: '金融科技', description: '合规与交易链路' },
      ],
    };
    setExternalPlugins([externalEntry(pack)]);

    // 变体随包进本机清单：界面按选中岗位包取选项
    expect(listInstalledPlugins().find((item) => item.id === 'demo.industry')?.industryVariants)
      .toEqual(pack.industryVariants);

    const chosen = setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'demo.industry',
      rolePackId: 'demo.industry',
      industryVariantId: 'fintech',
    });
    expect(chosen.descriptor.industryVariantId).toBe('fintech');
    expect(chosen.roleProfile?.industryVariantId).toBe('fintech');

    const unknown = setCampaignRoleProfile(raw, {
      campaignId: 'c1',
      roleFamily: 'demo.industry',
      rolePackId: 'demo.industry',
      industryVariantId: 'retail',
    });
    expect(unknown.descriptor.industryVariantId).toBeUndefined();
    expect(unknown.roleProfile?.industryVariantId).toBeNull();
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

describe('读路径补解析：有画像、没 descriptor', () => {
  let raw: Database;

  beforeEach(() => {
    raw = freshDb();
    installRolePacks();
  });

  afterEach(() => {
    setExternalPlugins([]);
  });

  /** 直接造出「画像已落库、运行时还没建起来」的状态：诊断/同步都可能先带来画像。 */
  function seedPendingProfile(campaignId: string, userConfirmed: 0 | 1): void {
    raw
      .prepare(
        `INSERT INTO role_profile (
           id, role_family, role_pack_id, level, industry_variant_id, location,
           interview_language, confidence, user_confirmed
         ) VALUES ('rp-pending', 'software', ?, NULL, NULL, NULL, 'zh', 0.8, ?)`,
      )
      .run(ROLE_PACK_ID, userConfirmed);
    raw.prepare(`UPDATE campaign SET role_profile_id = 'rp-pending' WHERE id = ?`).run(campaignId);
  }

  it('读 runtime 时自动解析出 descriptor 与 binding，画像立即生效', () => {
    seedPendingProfile('c1', 0);

    const view = getCampaignRuntime(raw, 'c1');

    expect(view?.descriptor).toMatchObject({
      campaignId: 'c1',
      rolePack: { id: ROLE_PACK_ID, version: ROLE_PACK_VERSION },
    });
    expect(view?.roleProfile?.rolePackId).toBe(ROLE_PACK_ID);
    // 自动解析不是用户的选择，不冒充「已确认」：画像原本未确认，解析完仍保持未确认
    expect(view?.roleProfile?.userConfirmed).toBe(false);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(1);
    const active = bindings(raw)
      .filter((row) => row.active_execution === 1)
      .map((row) => row.plugin_id)
      .sort();
    expect(active).toEqual([REPO_ID, ROLE_PACK_ID].sort());

    // 再读一次已经能命中 descriptor，不再生成第二个 revision
    expect(getCampaignRuntime(raw, 'c1')?.revision).toBe(1);
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(1);
  });

  it('岗位包没装时读 runtime 不写库，也不抛错', () => {
    seedPendingProfile('c1', 0);
    setExternalPlugins([]);

    expect(getCampaignRuntime(raw, 'c1')).toBeNull();
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(0);
    expect(count(raw, 'campaign_plugin_binding')).toBe(0);
  });

  it('既没有画像也没有 descriptor 的旧战役，读路径一行都不写', () => {
    const before = {
      descriptor: count(raw, 'campaign_runtime_descriptor'),
      binding: count(raw, 'campaign_plugin_binding'),
      profile: count(raw, 'role_profile'),
    };

    expect(getCampaignRuntime(raw, 'c1')).toBeNull();
    expect(count(raw, 'campaign_runtime_descriptor')).toBe(before.descriptor);
    expect(count(raw, 'campaign_plugin_binding')).toBe(before.binding);
    expect(count(raw, 'role_profile')).toBe(before.profile);
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
