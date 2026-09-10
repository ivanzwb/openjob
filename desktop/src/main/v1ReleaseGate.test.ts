/**
 * v1.0 发布关卡。
 *
 * 前面每个 Txx 都各自验过自己那块，这里只验一件它们各自验不到的事：三个岗位包
 * 和三个能力插件同时装在一份真实数据库上时，彼此不串味。
 *
 * 能力隔离在这里是矩阵而不是逐条：一个岗位包忘了声明依赖，逐条测通常仍然全绿
 * （它只看「我的能力在不在」），但矩阵会立刻指出多出来的那一格。工程岗多拿到
 * role-play、产品岗多拿到 source-repository 这类问题，用户侧的表现是练习页面
 * 冒出一个岗位根本不该有的题型。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { BUILT_IN_CAPABILITY_PLUGINS } from '@core/plugins/builtin';
import { ANALYTICS_CASE_CAPABILITY_ID } from '@core/plugins/builtin/analyticsCase';
import {
  PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS,
  PRODUCT_MANAGER_ROLE_PACK_ID,
} from '@plugins/productManager';
import { ROLE_PLAY_CAPABILITY_ID } from '@core/plugins/builtin/rolePlay';
import { SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID } from '@plugins/salesCustomerSuccess';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from '@core/plugins/builtin/sourceRepository';
import type { CampaignRuntimeDescriptor } from '@core/plugins/types';
import { buildClientCapabilityView } from '@core/plugins/clientView';
import { installRolePacks } from './plugins/__fixtures__/installedPlugins';
import {
  getCampaignRuntime,
  listInstalledPlugins,
  setCampaignRoleProfile,
} from './plugins/runtime';
import { syncTableSpecs } from './sync/tables';

const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');

/** 与 plugins/runtime.test.ts 相同的 node:sqlite 适配层 */
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

interface RolePackCase {
  label: string;
  rolePackId: string;
  roleFamily: string;
  /** 这个岗位包装上后应当自动启用的能力。 */
  capabilityId: string;
}

const ROLE_PACK_CASES: readonly RolePackCase[] = [
  {
    label: '软件工程',
    rolePackId: softwareEngineeringRolePack.manifest.id,
    roleFamily: 'software',
    capabilityId: SOURCE_REPOSITORY_CAPABILITY_ID,
  },
  {
    label: '产品经理',
    rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
    roleFamily: 'product',
    capabilityId: ANALYTICS_CASE_CAPABILITY_ID,
  },
  {
    label: '销售客户成功',
    rolePackId: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
    roleFamily: 'sales',
    capabilityId: ROLE_PLAY_CAPABILITY_ID,
  },
];

/** 三个能力插件的 ID，顺序与 ROLE_PACK_CASES 的对角线一致。 */
const CAPABILITY_IDS = ROLE_PACK_CASES.map((item) => item.capabilityId);

let raw: Database;

function freshDb(): Database {
  const db = adapt(new DatabaseSync(':memory:'));
  db.exec('PRAGMA foreign_keys = ON');
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .forEach((file) => {
      readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
        .split('--> statement-breakpoint')
        .forEach((statement) => {
          if (statement.trim()) db.exec(statement);
        });
    });
  return db;
}

function newCampaign(id: string): void {
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, 'ACME', '岗位', 'JD', 'planning', 1, 1)`,
    )
    .run(id);
}

/** 建一个战役并绑定岗位包，返回落库后的描述符。 */
function bindRolePack(item: RolePackCase): CampaignRuntimeDescriptor {
  const campaignId = `c-${item.rolePackId}`;
  newCampaign(campaignId);
  return setCampaignRoleProfile(
    raw,
    { campaignId, roleFamily: item.roleFamily, rolePackId: item.rolePackId },
    { now: () => 1 },
  ).descriptor;
}

function enabledIds(descriptor: CampaignRuntimeDescriptor): string[] {
  return descriptor.capabilities.filter((item) => item.enabled).map((item) => item.id);
}

beforeEach(() => {
  raw = freshDb();
  // 三个岗位包现在是用户自己装的：这条关卡问的是「都装上之后彼此不串味」
  installRolePacks();
});

describe('三个岗位包在同一份库上共存', () => {
  it.each(ROLE_PACK_CASES)('$label 绑定后 descriptor 与 binding 都落了库', (item) => {
    const descriptor = bindRolePack(item);

    expect(descriptor.rolePack.id).toBe(item.rolePackId);
    expect(descriptor.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);

    const bound = raw
      .prepare(
        `SELECT plugin_id FROM campaign_plugin_binding
         WHERE campaign_id = ? AND active_execution = 1 ORDER BY plugin_id`,
      )
      .all(`c-${item.rolePackId}`) as Array<{ plugin_id: string }>;
    // 岗位包自己和它启用的能力都要有 binding，否则历史结果无法解释
    expect(bound.map((row) => row.plugin_id)).toEqual(
      [item.rolePackId, ...enabledIds(descriptor)].sort(),
    );
  });

  it('三个岗位包解析出三份不同的快照', () => {
    const hashes = ROLE_PACK_CASES.map((item) => bindRolePack(item).configSnapshotHash);
    // hash 相同说明岗位包没真正进入快照，Prompt 组合与评分就会串到一起
    expect(new Set(hashes).size).toBe(ROLE_PACK_CASES.length);
  });
});

describe('能力隔离矩阵', () => {
  it('每个岗位包只拿到自己声明的那一个能力', () => {
    const matrix = ROLE_PACK_CASES.map((item) => {
      const enabled = new Set(enabledIds(bindRolePack(item)));
      return CAPABILITY_IDS.map((capabilityId) => enabled.has(capabilityId));
    });

    // 对角线为真、其余为假：多出来的那一格就是某个岗位包多拿了一个能力
    expect(matrix).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
  });

  it('岗位包没声明的能力即使装在本机也不会被启用', () => {
    const descriptor = bindRolePack(ROLE_PACK_CASES[0]);
    const installed = listInstalledPlugins().map((plugin) => plugin.id);

    // 三个能力插件都随应用发布，所以「没启用」不可能是「没装」
    for (const capabilityId of CAPABILITY_IDS) {
      expect(installed).toContain(capabilityId);
    }
    expect(enabledIds(descriptor)).toEqual([SOURCE_REPOSITORY_CAPABILITY_ID]);
  });
});

describe('两端消费同一份 descriptor', () => {
  it.each(ROLE_PACK_CASES)('$label 在桌面与手机上只有 mode 不同', (item) => {
    const descriptor = bindRolePack(item);
    const input = { descriptor, installed: listInstalledPlugins() };
    const desktop = buildClientCapabilityView({ ...input, platform: 'desktop' });
    const mobile = buildClientCapabilityView({ ...input, platform: 'mobile' });

    expect(mobile.configSnapshotHash).toBe(desktop.configSnapshotHash);
    expect(mobile.capabilities.map((entry) => entry.id)).toEqual(
      desktop.capabilities.map((entry) => entry.id),
    );

    // 手机端的可用性以 Manifest 声明为准，不在这里重写一份预期
    const manifest = BUILT_IN_CAPABILITY_PLUGINS.find(
      (plugin) => plugin.manifest.id === item.capabilityId,
    )?.manifest;
    expect(mobile.capabilities.find((entry) => entry.id === item.capabilityId)?.mode).toBe(
      manifest?.runtime?.mobile,
    );
  });
});

describe('未交付的能力留在 backlog，不阻塞发布', () => {
  it('产品岗缺 portfolio-review 时照常拿到完整 descriptor', () => {
    const descriptor = bindRolePack(ROLE_PACK_CASES[1]);
    const ref = descriptor.capabilities.find(
      (item) => item.id === PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS.portfolioReview,
    );

    // 未实现的可选能力只以 disabled 出现，解析不失败、战役照常可用
    expect(ref).toMatchObject({ enabled: false });
    expect(ref?.enabled === false ? ref.disabledReason : '').toContain('plugin-not-found');
    expect(enabledIds(descriptor)).toContain(ANALYTICS_CASE_CAPABILITY_ID);
  });

  it('本机根本没有的能力不会被凭空写进 descriptor', () => {
    const descriptor = bindRolePack(ROLE_PACK_CASES[2]);
    // presentation-review 还没人声明依赖，就不该出现在任何描述符里
    expect(descriptor.capabilities.map((item) => item.id)).not.toContain('presentation-review');
  });
});

describe('插件运行时随端间同步一起走', () => {
  it('三张运行时表都在同步清单里', () => {
    const synced = syncTableSpecs().map((spec) => spec.name);
    // 少任何一张，换端之后岗位与能力绑定就会凭空消失
    for (const table of ['role_profile', 'campaign_plugin_binding', 'campaign_runtime_descriptor']) {
      expect(synced, table).toContain(table);
    }
  });

  it('descriptor 的 capabilities 整列参与同步', () => {
    const spec = syncTableSpecs().find((item) => item.name === 'campaign_runtime_descriptor');
    expect(spec?.columns).toContain('capabilities');
    expect(spec?.columns).toContain('config_snapshot_hash');
    // 运行时描述符没有本机专属列：两端必须看到逐字相同的一份
    expect(spec?.deviceLocal).toEqual([]);
  });
});

describe('旧 Campaign 继续可用', () => {
  it('没有岗位画像的战役读运行时不报错，也不写任何一行', () => {
    newCampaign('c-legacy');
    const before = raw
      .prepare(`SELECT count(*) AS n FROM campaign_runtime_descriptor`)
      .get() as { n: number };

    const runtime = getCampaignRuntime(raw, 'c-legacy');

    // 读路径一行都不写：否则升级后第一次打开旧战役就会悄悄生成一份绑定
    expect(runtime?.descriptor ?? null).toBeNull();
    expect(raw.prepare(`SELECT count(*) AS n FROM campaign_runtime_descriptor`).get()).toEqual(
      before,
    );
  });

  it('绑定岗位包不动 Campaign 的既有列', () => {
    newCampaign('c-keep');
    const before = raw.prepare(`SELECT * FROM campaign WHERE id = 'c-keep'`).get() as Record<
      string,
      unknown
    >;

    setCampaignRoleProfile(
      raw,
      { campaignId: 'c-keep', roleFamily: 'software', rolePackId: ROLE_PACK_CASES[0].rolePackId },
      { now: () => 1 },
    );

    const after = raw.prepare(`SELECT * FROM campaign WHERE id = 'c-keep'`).get() as Record<
      string,
      unknown
    >;
    // 只允许多出 role_profile_id 这一处变化
    for (const key of Object.keys(before)) {
      if (key === 'role_profile_id') continue;
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after.role_profile_id).not.toBeNull();
  });
});
