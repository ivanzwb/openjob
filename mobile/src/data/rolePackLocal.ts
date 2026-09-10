/**
 * 手机端的岗位包。
 *
 * 岗位包移出基础包之后，「本机有哪些岗位包」在桌面端是扫 userData/plugins 得出的。手机端
 * 没有那个目录，也不安装包：它没法验 Ed25519（expo-crypto 只有摘要），装了也用不上——
 * 能力插件的工具实现全在桌面主进程里。
 *
 * 所以手机端只做一件事：把已配对桌面端**已经安装并验过签名**的岗位包数据要一份过来缓存。
 * 岗位包是纯数据，拿到就能用；缓存按 id@version 存，descriptor 换版本就是另一条记录，
 * 不会拿旧版本的题型糊弄新绑定。
 *
 * 这份缓存不进同步表，理由与 repo.local_path 相同：它是设备属性，不是备考数据。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { listBuiltInPlugins, toInstalledPlugin, type InstalledPlugin } from '@shared/plugins/clientView';
import { parseTransferredRolePack } from '@shared/plugins/package/rolePackTransfer';
import type { ResolvedPluginRef, RolePack } from '@shared/plugins/types';
import { invokeRemote } from '../remote/rpc';

export interface RolePackRef {
  id: string;
  version: string;
}

export interface RolePackDeliveryRow extends RolePackRef {
  displayName: string | null;
  /** 数据已经在本机，断网也打得开 */
  present: boolean;
  /** 上次取回的时间，没取过为 null */
  fetchedAt: number | null;
}

function keyOf(ref: RolePackRef): string {
  return `${ref.id}@${ref.version}`;
}

export function getCachedRolePack(
  db: SQLiteDatabase,
  id: string,
  version: string,
): RolePack | null {
  const row = db.getFirstSync<{ pack_json: string }>(
    `SELECT pack_json FROM role_pack_cache WHERE id = ? AND version = ?`,
    id,
    version,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.pack_json) as RolePack;
  } catch {
    // 缓存行损坏等价于没缓存：下一轮同步会重新取一份，不该把界面打挂
    return null;
  }
}

export function listCachedRolePacks(db: SQLiteDatabase): RolePack[] {
  return db
    .getAllSync<{ pack_json: string }>(`SELECT pack_json FROM role_pack_cache ORDER BY id, version`)
    .flatMap((row) => {
      try {
        return [JSON.parse(row.pack_json) as RolePack];
      } catch {
        return [];
      }
    });
}

export function cacheRolePack(db: SQLiteDatabase, pack: RolePack, now = Date.now()): void {
  db.runSync(
    `INSERT INTO role_pack_cache (id, version, pack_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id, version) DO UPDATE SET pack_json = excluded.pack_json,
       fetched_at = excluded.fetched_at`,
    pack.manifest.id,
    pack.manifest.version,
    JSON.stringify(pack),
    now,
  );
}

/**
 * 本机战役固定的岗位包，按 id@version 去重。
 *
 * 只看当前激活的那个 revision：旧 revision 的历史结果仍然可读（靠 practice_session 上的
 * 快照字段），不需要为此把每个历史版本的包都拉到手机上。
 */
export function pinnedRolePackRefs(db: SQLiteDatabase): RolePackRef[] {
  const rows = db.getAllSync<{ role_pack: string }>(
    `SELECT d.role_pack FROM campaign_runtime_descriptor d
     JOIN (
       SELECT campaign_id, max(revision) AS revision
       FROM campaign_runtime_descriptor GROUP BY campaign_id
     ) latest ON latest.campaign_id = d.campaign_id AND latest.revision = d.revision`,
  );

  const byKey = new Map<string, RolePackRef>();
  for (const row of rows) {
    let ref: ResolvedPluginRef;
    try {
      ref = JSON.parse(row.role_pack) as ResolvedPluginRef;
    } catch {
      continue;
    }
    if (!ref?.id || !ref.version) continue;
    byKey.set(keyOf(ref), { id: ref.id, version: ref.version });
  }
  return [...byKey.values()].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
}

/**
 * 本机安装集合。
 *
 * `buildClientCapabilityView` 的 `installed` 必须是**本机**的集合。以前手机端不传，桌面
 * 替它兜底成桌面自己的清单，于是桌面装了什么就算手机也有——一个只在桌面装了的岗位包会让
 * 手机端把战役判成正常，而它其实一道题都出不了。
 *
 * 能力插件随应用发布，两端都有（它们自己声明成手机 view-only）；岗位包只算取回来的那些。
 */
export function installedPluginsHere(db: SQLiteDatabase): InstalledPlugin[] {
  return [
    ...listBuiltInPlugins(),
    ...listCachedRolePacks(db).map((pack) => toInstalledPlugin(pack.manifest)),
  ];
}

/** 界面用的下发状态：每个被固定的岗位包，数据到了没有。 */
export function rolePackDelivery(db: SQLiteDatabase): RolePackDeliveryRow[] {
  return pinnedRolePackRefs(db).map((ref) => {
    const row = db.getFirstSync<{ pack_json: string; fetched_at: number }>(
      `SELECT pack_json, fetched_at FROM role_pack_cache WHERE id = ? AND version = ?`,
      ref.id,
      ref.version,
    );
    const cached = row ? getCachedRolePack(db, ref.id, ref.version) : null;
    return {
      ...ref,
      displayName: cached?.manifest.displayName ?? null,
      present: cached !== null,
      fetchedAt: row?.fetched_at ?? null,
    };
  });
}

export interface RolePackFetchOutcome {
  fetched: RolePackRef[];
  /** 没取到的包与原因：桌面端没装、版本不符、结构不合法都在这里 */
  failed: (RolePackRef & { detail: string })[];
}

/**
 * 把缺的岗位包从桌面端取回来。
 *
 * 逐个取而不是一次要全部：一个包坏了或桌面端只装了其中两个时，其余的照样该到手。整轮
 * 同步不因为这件事失败——取不到岗位包只是「手机上暂时练不了这个岗位」，而同步搬的备考
 * 数据与它无关。
 */
export async function fetchMissingRolePacks(
  db: SQLiteDatabase,
  now = Date.now(),
): Promise<RolePackFetchOutcome> {
  const outcome: RolePackFetchOutcome = { fetched: [], failed: [] };

  for (const ref of pinnedRolePackRefs(db)) {
    if (getCachedRolePack(db, ref.id, ref.version)) continue;

    let payload: unknown;
    try {
      const response = await invokeRemote<'plugin:getRolePack', RolePackRef, unknown>(
        'plugin:getRolePack',
        ref,
      );
      payload = response.result;
    } catch (error) {
      outcome.failed.push({
        ...ref,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const parsed = parseTransferredRolePack(payload, ref);
    if (!parsed.ok) {
      outcome.failed.push({ ...ref, detail: parsed.detail });
      continue;
    }
    cacheRolePack(db, parsed.pack, now);
    outcome.fetched.push(ref);
  }

  return outcome;
}
