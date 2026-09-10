/**
 * 手机端的岗位包缓存。
 *
 * 这里守的是 P10 的那句判据：两端安装集合不同时，视图不误报。手机端不安装插件包，桌面装了
 * 什么不等于手机有什么——把桌面的清单当成手机的，一个只在桌面装了的岗位包会让手机把战役
 * 判成正常，而它其实一道题都出不了。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClientCapabilityView, listBuiltInPlugins } from '@shared/plugins/clientView';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import type { CampaignRuntimeDescriptor, RolePack } from '@shared/plugins/types';
import { MIGRATIONS } from '../db/migrations/bundle';
import { ensureCriticalSchema } from '../db/schemaEnsure';

const remote = vi.hoisted(() => ({
  reply: (_channel: string, _payload: unknown): unknown => null,
  calls: [] as { channel: string; payload: unknown }[],
}));

vi.mock('../remote/rpc', () => ({
  invokeRemote: (channel: string, payload: unknown) => {
    remote.calls.push({ channel, payload });
    return Promise.resolve({ result: remote.reply(channel, payload) });
  },
}));

const {
  cacheRolePack,
  fetchMissingRolePacks,
  getCachedRolePack,
  installedPluginsHere,
  pinnedRolePackRefs,
  rolePackDelivery,
} = await import('./rolePackLocal');

const PACK = DISTRIBUTED_ROLE_PACKS[0]!;
const OTHER_PACK = DISTRIBUTED_ROLE_PACKS[1]!;

/** 与 apply.fk.test.ts 相同的 node:sqlite 适配层 */
function adapt(db: DatabaseSync): SQLiteDatabase {
  const shim = {
    execSync: (sql: string) => db.exec(sql),
    runSync: (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[])),
    getAllSync: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])),
    getFirstSync: (sql: string, ...args: unknown[]) =>
      db.prepare(sql).get(...(args as never[])) ?? null,
    closeSync: () => db.close(),
  };
  return shim as unknown as SQLiteDatabase;
}

function freshDb(): SQLiteDatabase {
  const raw = adapt(new DatabaseSync(':memory:'));
  raw.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) raw.execSync(trimmed);
    }
  }
  // role_pack_cache 是设备本地表，不在同步迁移里，靠 ensureCriticalSchema 建
  ensureCriticalSchema(raw);
  return raw;
}

function seedCampaign(raw: SQLiteDatabase, id: string, pack: RolePack, revision = 1): void {
  raw.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
     VALUES (?, 'ACME', '工程师', 'jd', 'planning', 1, 1)`,
    id,
  );
  raw.runSync(
    `INSERT INTO campaign_runtime_descriptor (
       id, campaign_id, revision, core_version, role_pack, industry_pack,
       capabilities, competency_baseline_version, config_snapshot_hash, resolved_at
     ) VALUES (?, ?, ?, '1.0.0', ?, NULL, '[]', '1.0.0', 'hash', 1)`,
    `${id}-descriptor-${revision}`,
    id,
    revision,
    JSON.stringify({ id: pack.manifest.id, version: pack.manifest.version }),
  );
}

let raw: SQLiteDatabase;

beforeEach(() => {
  raw = freshDb();
  remote.calls = [];
  remote.reply = () => null;
});

afterEach(() => {
  raw.closeSync();
});

describe('pinnedRolePackRefs', () => {
  it('只看每个战役当前激活的那个 revision', () => {
    seedCampaign(raw, 'c1', OTHER_PACK, 1);
    raw.runSync(
      `INSERT INTO campaign_runtime_descriptor (
         id, campaign_id, revision, core_version, role_pack, industry_pack,
         capabilities, competency_baseline_version, config_snapshot_hash, resolved_at
       ) VALUES ('c1-descriptor-2', 'c1', 2, '1.0.0', ?, NULL, '[]', '1.0.0', 'hash', 2)`,
      JSON.stringify({ id: PACK.manifest.id, version: PACK.manifest.version }),
    );

    // 换过岗位的战役只按现在这个岗位取包：旧 revision 的历史结果靠 practice_session
    // 上的快照字段读，不需要把每个历史版本的包都拉到手机上
    expect(pinnedRolePackRefs(raw)).toEqual([
      { id: PACK.manifest.id, version: PACK.manifest.version },
    ]);
  });

  it('多个战役固定同一个包时只取一次', () => {
    seedCampaign(raw, 'c1', PACK);
    seedCampaign(raw, 'c2', PACK);

    expect(pinnedRolePackRefs(raw)).toHaveLength(1);
  });

  it('还没选岗位的战役不产生要取的包', () => {
    raw.runSync(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES ('c1', 'ACME', '工程师', 'jd', 'planning', 1, 1)`,
    );

    expect(pinnedRolePackRefs(raw)).toEqual([]);
  });
});

describe('installedPluginsHere', () => {
  it('一个岗位包都没取到时只有随应用发布的能力插件', () => {
    expect(installedPluginsHere(raw).map((plugin) => plugin.id)).toEqual(
      listBuiltInPlugins().map((plugin) => plugin.id),
    );
  });

  it('取回来的岗位包才算本机装了，桌面装了不算', () => {
    cacheRolePack(raw, PACK);

    const ids = installedPluginsHere(raw).map((plugin) => plugin.id);
    expect(ids).toContain(PACK.manifest.id);
    expect(ids).not.toContain(OTHER_PACK.manifest.id);
  });

  /**
   * 这条是 P10 的落点：同一份 descriptor，数据到手机之前视图必须说「没装」，到了之后
   * 才是 full。以前手机端不传 installed，桌面替它兜底成桌面自己的清单，两种状态在手机
   * 上长得一模一样。
   */
  it('岗位包数据到手机之前视图判为未安装，到了之后才可执行', () => {
    const descriptor: CampaignRuntimeDescriptor = {
      campaignId: 'c1',
      coreVersion: '1.0.0',
      rolePack: { id: PACK.manifest.id, version: PACK.manifest.version },
      capabilities: [],
      competencyBaselineVersion: PACK.manifest.version,
      configSnapshotHash: 'a'.repeat(64),
      resolvedAt: 1,
    };
    const viewNow = (): ReturnType<typeof buildClientCapabilityView> =>
      buildClientCapabilityView({
        descriptor,
        platform: 'mobile',
        installed: installedPluginsHere(raw),
      });

    expect(viewNow().rolePack).toMatchObject({
      installed: false,
      mode: 'view-only',
      reason: 'plugin-not-installed',
    });

    cacheRolePack(raw, PACK);

    expect(viewNow().rolePack).toMatchObject({ installed: true, mode: 'full', reason: null });
    // 两端解析结果不因此改变：视图只复述 descriptor
    expect(viewNow().configSnapshotHash).toBe(descriptor.configSnapshotHash);
  });
});

describe('fetchMissingRolePacks', () => {
  it('缺的才去要，已经在本机的不重复取', () => {
    seedCampaign(raw, 'c1', PACK);
    seedCampaign(raw, 'c2', OTHER_PACK);
    cacheRolePack(raw, PACK);
    remote.reply = (_channel, payload) =>
      (payload as { id: string }).id === OTHER_PACK.manifest.id ? OTHER_PACK : null;

    return fetchMissingRolePacks(raw).then((outcome) => {
      expect(remote.calls.map((call) => (call.payload as { id: string }).id)).toEqual([
        OTHER_PACK.manifest.id,
      ]);
      expect(outcome.fetched).toEqual([
        { id: OTHER_PACK.manifest.id, version: OTHER_PACK.manifest.version },
      ]);
      expect(getCachedRolePack(raw, OTHER_PACK.manifest.id, OTHER_PACK.manifest.version)).toMatchObject(
        { manifest: { id: OTHER_PACK.manifest.id } },
      );
    });
  });

  it('桌面端没装这个包时记下原因，不写坏缓存', async () => {
    seedCampaign(raw, 'c1', PACK);
    remote.reply = () => null;

    const outcome = await fetchMissingRolePacks(raw);

    expect(outcome.fetched).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(getCachedRolePack(raw, PACK.manifest.id, PACK.manifest.version)).toBeNull();
  });

  it('对端给的版本不是要的那一版就拒收', async () => {
    seedCampaign(raw, 'c1', PACK);
    remote.reply = () => {
      const wrong = structuredClone(PACK) as RolePack;
      wrong.manifest = { ...wrong.manifest, version: '9.9.9' };
      return wrong;
    };

    const outcome = await fetchMissingRolePacks(raw);

    expect(outcome.failed[0]?.detail).toContain('9.9.9');
    expect(getCachedRolePack(raw, PACK.manifest.id, PACK.manifest.version)).toBeNull();
  });

  /** 一个包坏了不该让其余的也拿不到：逐个取，逐个记原因 */
  it('一个包失败不影响其它包取回', async () => {
    seedCampaign(raw, 'c1', PACK);
    seedCampaign(raw, 'c2', OTHER_PACK);
    remote.reply = (_channel, payload) => {
      if ((payload as { id: string }).id === PACK.manifest.id) throw new Error('桌面端已离线');
      return OTHER_PACK;
    };

    const outcome = await fetchMissingRolePacks(raw);

    expect(outcome.fetched.map((ref) => ref.id)).toEqual([OTHER_PACK.manifest.id]);
    expect(outcome.failed[0]).toMatchObject({ id: PACK.manifest.id, detail: '桌面端已离线' });
  });
});

describe('rolePackDelivery', () => {
  it('逐个报出「数据到了没有」，界面据此显示取回入口', () => {
    seedCampaign(raw, 'c1', PACK);
    seedCampaign(raw, 'c2', OTHER_PACK);
    cacheRolePack(raw, PACK, 1700000000000);

    expect(rolePackDelivery(raw)).toEqual(
      expect.arrayContaining([
        {
          id: PACK.manifest.id,
          version: PACK.manifest.version,
          displayName: PACK.manifest.displayName,
          present: true,
          fetchedAt: 1700000000000,
        },
        {
          id: OTHER_PACK.manifest.id,
          version: OTHER_PACK.manifest.version,
          displayName: null,
          present: false,
          fetchedAt: null,
        },
      ]),
    );
  });
});
