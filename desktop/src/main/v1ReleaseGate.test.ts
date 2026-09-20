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

import { capabilityEntriesFromRolePack } from '@core/plugins/capabilityEntries';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { productManagerRolePack } from '@plugins/productManager';
import { salesCustomerSuccessRolePack } from '@plugins/salesCustomerSuccess';

/**
 * 岗位包内嵌能力的 id：descriptor 的能力引用、binding 行、清单项用的都是它。
 *
 * 一个包声明几条能力就是几条，没有「合编包」这一层。
 */
function capabilityIdsOf(pack: RolePack): string[] {
  return (pack.capabilities ?? []).map((declaration) => declaration.id);
}

/** 某个能力的本机条目形态（mobile 可用性由它声明）。 */
function capabilityEntryOf(pack: RolePack, capabilityId: string): InstalledPlugin {
  const entry = capabilityEntriesFromRolePack(pack).find((item) => item.id === capabilityId);
  if (!entry) throw new Error(`${pack.manifest.id} 没有能力 ${capabilityId}`);
  return entry;
}

import {
  PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS,
  PRODUCT_MANAGER_ROLE_PACK_ID,
} from '@plugins/productManager';
import { SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID } from '@plugins/salesCustomerSuccess';
import type { CampaignRuntimeDescriptor, RolePack } from '@core/plugins/types';
import type { InstalledPlugin } from '@core/plugins/clientView';
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
    capabilityId: capabilityIdsOf(softwareEngineeringRolePack)[0]!,
  },
  {
    label: '产品经理',
    rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
    roleFamily: 'product',
    capabilityId: capabilityIdsOf(productManagerRolePack)[0]!,
  },
  {
    label: '销售客户成功',
    rolePackId: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
    roleFamily: 'sales',
    capabilityId: capabilityIdsOf(salesCustomerSuccessRolePack)[0]!,
  },
];

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

describe('能力绑定', () => {
  it('每个岗位包启用自己的内嵌能力，各绑一条', () => {
    // 能力随岗位包分发：隔离靠岗位包各自的题型声明（哪些题型挂 capabilityId）与战役级
    // 启用开关，而不是靠把三个能力塞进同一个包。这里守的是绑定结果：每个岗位包恰好
    // 绑定它自己声明的能力。
    for (const item of ROLE_PACK_CASES) {
      const descriptor = bindRolePack(item);
      expect(enabledIds(descriptor)).toEqual([item.capabilityId]);
    }
  });

  it('别的岗位包声明的能力即使装在本机也不会被启用', () => {
    const descriptor = bindRolePack(ROLE_PACK_CASES[0]);
    const installed = listInstalledPlugins().map((plugin) => plugin.id);

    for (const item of ROLE_PACK_CASES) {
      expect(installed).toContain(item.capabilityId);
    }
    // SE 战役只启用它自己声明的能力；PM/sales 的能力不归这个战役
    expect(enabledIds(descriptor)).toEqual([ROLE_PACK_CASES[0].capabilityId]);
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

    // 手机端的可用性以能力条目的运行时声明为准，不在这里重写一份预期
    const pack = [softwareEngineeringRolePack, productManagerRolePack, salesCustomerSuccessRolePack].find(
      (candidate) => candidate.manifest.id === item.rolePackId,
    )!;
    const entry = capabilityEntryOf(pack, item.capabilityId);
    expect(mobile.capabilities.find((status) => status.id === item.capabilityId)?.mode).toBe(
      entry.runtime?.mobile,
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
    expect(enabledIds(descriptor)).toContain(ROLE_PACK_CASES[1].capabilityId);
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
    newCampaign('c-prePlugin');
    const before = raw
      .prepare(`SELECT count(*) AS n FROM campaign_runtime_descriptor`)
      .get() as { n: number };

    const runtime = getCampaignRuntime(raw, 'c-prePlugin');

    // 读路径一行都不写：否则升级后第一次打开旧战役就会悄悄生成一份绑定
    expect(runtime?.descriptor ?? null).toBeNull();
    expect(raw.prepare(`SELECT count(*) AS n FROM campaign_runtime_descriptor`).get()).toEqual(
      before,
    );
  });

  it('有岗位画像却没有 descriptor 的战役，读运行时会自动补解析', () => {
    // 画像先于运行时落库是可能的（诊断先给出画像、或跨端同步只带来画像）；
    // 这场备考不该要用户先打开岗位面板才用得上
    newCampaign('c-profiled');
    raw
      .prepare(
        `INSERT INTO role_profile (
           id, role_family, role_pack_id, level, industry_pack_id, location,
           interview_language, confidence, user_confirmed
         ) VALUES ('rp-profiled', 'software', ?, NULL, NULL, NULL, 'zh', 0.5, 0)`,
      )
      .run(ROLE_PACK_CASES[0].rolePackId);
    raw
      .prepare(`UPDATE campaign SET role_profile_id = 'rp-profiled' WHERE id = 'c-profiled'`)
      .run();

    const runtime = getCampaignRuntime(raw, 'c-profiled');

    expect(runtime?.descriptor.rolePack.id).toBe(ROLE_PACK_CASES[0].rolePackId);
    const bound = raw
      .prepare(
        `SELECT plugin_id FROM campaign_plugin_binding
         WHERE campaign_id = 'c-profiled' AND active_execution = 1 ORDER BY plugin_id`,
      )
      .all() as Array<{ plugin_id: string }>;
    expect(bound.map((row) => row.plugin_id)).toEqual(
      [ROLE_PACK_CASES[0].rolePackId, ...enabledIds(runtime!.descriptor)].sort(),
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
