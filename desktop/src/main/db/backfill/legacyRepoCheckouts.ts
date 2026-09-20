/**
 * 旧仓库登记行的「本机检出」补齐。
 *
 * 0029 那条迁移把旧的仓库登记表搬进包声明的 `repositories` 集合时，刻意没搬
 * `local_path`——理由是那个路径属于具体设备，同步到手机或另一台机器上就是错的。
 * 但升级本身是**本机**的事：这份库里存的就是本机路径，丢掉它等于把用户已经 clone
 * 好的检出扔了，源码页上只剩「已登记，本机还没有检出」，重建索引也点不动。
 *
 * 所以这里在启动时补一次，且只补本机确实存在的目录：
 * 1. 1.0 的工作区边界写死在 `userData/plugin-workspace/<pluginId>/`（绝对路径一律拒），
 *    0.6.x 的检出落在 `userData` 下的另一个目录里，原地用不了，因此把它**改名**搬进
 *    包工作区——同一个卷内是元数据操作，不复制字节；名字用 `deriveDirName(url)`，与包
 *    在工作区里新拉一个检出得到的名字一致，之后「更新到最新」按同一个 dir 走。
 * 2. 搬不动（目录不存在、权限、同名目录已占）就**什么都不改**：宁可它还是「未检出」，
 *    也不能给登记行写一个指不到或指向别的仓库的 dir。
 *
 * 只在 `dir` 为空的行上动手，因此跑一次之后就是空转；与那些旧表一样，这条路径
 * 不参与跨设备同步。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { deriveDirName } from '../../workspace/gitFetch';

export interface LegacyRepoCheckoutResult {
  /** 补上 dir 的登记行数 */
  attached: number;
  /** 顺带把旧检出搬进包工作区的次数 */
  adopted: number;
}

interface EntryRow {
  id: string;
  plugin_id: string;
  key: string;
  value_json: string;
}

/** 登记行里读 url：值不是 JSON 或缺 url 时返回空串（这一行只能放着不动）。 */
function urlOf(valueJson: string): string {
  try {
    const parsed = JSON.parse(valueJson) as { url?: unknown };
    return typeof parsed.url === 'string' ? parsed.url : '';
  } catch {
    return '';
  }
}

export function backfillLegacyRepoCheckouts(
  raw: Database,
  workspaceRoot: (pluginId: string) => string,
  now: number = Date.now(),
): LegacyRepoCheckoutResult {
  const entries = raw
    .prepare(
      `SELECT id, plugin_id, key, value_json
         FROM plugin_data
        WHERE collection = 'repositories'
          AND json_extract(value_json, '$.dir') IS NULL`,
    )
    .all() as EntryRow[];
  if (entries.length === 0) return { attached: 0, adopted: 0 };

  const legacyPaths = new Map<string, string>(
    (raw.prepare('SELECT id, local_path FROM repo').all() as { id: string; local_path: string }[]).map(
      (row) => [row.id, row.local_path],
    ),
  );

  const update = raw.prepare(
    `UPDATE plugin_data
        SET value_json = json_set(value_json, '$.dir', ?),
            updated_at = ?
      WHERE id = ?`,
  );

  let attached = 0;
  let adopted = 0;

  for (const entry of entries) {
    const source = legacyPaths.get(entry.key);
    if (!source || !existsSync(source)) continue;

    const url = urlOf(entry.value_json);
    if (!url) continue;

    const name = deriveDirName(url);
    const root = workspaceRoot(entry.plugin_id);
    const target = join(root, name);
    // 工作区里已经有这个名字就不碰：它可能是别的来源拉的，写上去等于让用户看错仓库
    if (existsSync(target)) continue;

    try {
      mkdirSync(root, { recursive: true });
      renameSync(source, target);
    } catch {
      continue;
    }

    update.run(name, now, entry.id);
    adopted += 1;
    attached += 1;
  }

  return { attached, adopted };
}
