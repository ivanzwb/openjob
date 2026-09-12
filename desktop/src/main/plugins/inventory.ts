/**
 * 扫描 userData/plugins，得出本机真实装了哪些外置插件。
 *
 * 「装了什么」是设备本地属性，和 repo_file.local_path、搜索缓存同类，不进同步：两台
 * 设备装的插件本来就可以不同，把它同步过去只会让手机端声称自己有一个它跑不了的包。
 *
 * 坏包一律**报出来**而不是静默跳过。一个装了却没生效的插件是最难排查的故障——用户
 * 看到的是「岗位列表里没有它」，而日志里什么都没有。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isCodeAssetName,
  PACKAGE_ALLOWED_FILES,
  parsePluginPackage,
  validatePluginPackage,
  type ParsedPluginPackage,
  type PluginPackageFiles,
} from '@core/plugins/package/contract';
import { scanPluginSources } from '@core/plugins/codePlugin/scan';
import { classifyPackageTrust, type PackageTrust } from './package/signature';

/**
 * 单个文件的大小上限。
 *
 * 插件包全是 JSON 声明，最大的岗位包也只有几十 KB。设上限是因为扫描发生在启动路径上，
 * 一个几百 MB 的文件（不管是恶意的还是拷错的）会把启动卡死。
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type PluginRejectionReason =
  /** 目录名与 manifest 的 id@version 不一致 */
  | 'directory-mismatch'
  /** 包格式或声明不合法 */
  | 'invalid-package'
  /** 内容与签名不符，或签名文件本身坏了 */
  | 'tampered'
  /** 没有签名 */
  | 'unsigned'
  /** 签名者不在信任列表，等用户显式决定 */
  | 'untrusted-signer'
  /** 与内置插件或另一个外置包撞了同一个 id@version */
  | 'duplicate'
  /** 代码插件的静态隔离扫描未通过（§13.4 准入第二层） */
  | 'isolation-violation'
  /** 读取失败 */
  | 'unreadable';

export interface PluginInventoryEntry {
  dir: string;
  trust: PackageTrust;
  package: ParsedPluginPackage;
}

export interface PluginInventoryRejection {
  dir: string;
  reason: PluginRejectionReason;
  detail: string;
}

export interface PluginInventory {
  /** 可以装配进注册表的包 */
  entries: PluginInventoryEntry[];
  /** 装不了的包，连同原因，供 UI 与日志展示 */
  rejected: PluginInventoryRejection[];
}

export interface ScanOptions {
  pluginsDir: string;
  /** 第一方发布公钥（SPKI PEM） */
  trustedPublicKeys: readonly string[];
  /**
   * 已被内置插件占用的 `id@version`。
   *
   * 外置包不允许顶替内置包：允许的话，换一个同名同版本的包就能悄悄改掉内置岗位包的
   * 量规和提示词，而 descriptor 里的 hash 一个字都不变。
   */
  reservedKeys?: ReadonlySet<string>;
}

type ReadResult = { ok: true; files: PluginPackageFiles } | { ok: false; error: string };

function readPackageFiles(dir: string): ReadResult {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      // 目录名照样交给格式校验去否决：白名单里没有目录（ui/ 除外，下面递归读）
      if (entry.name !== 'ui') files[entry.name] = '';
      continue;
    }
    if (!PACKAGE_ALLOWED_FILES.includes(entry.name) && !isCodeAssetName(entry.name)) {
      // 内容不读，但名字要进去，这样白名单校验能报出这个文件
      files[entry.name] = '';
      continue;
    }
    const path = join(dir, entry.name);
    if (statSync(path).size > MAX_FILE_BYTES) {
      return { ok: false, error: `${entry.name} 超过 ${MAX_FILE_BYTES} 字节上限` };
    }
    files[entry.name] = readFileSync(path, 'utf8');
  }

  // 代码插件的 Webview 资源：ui/ 递归读为 ui/<相对路径>
  const uiDir = join(dir, 'ui');
  if (existsSync(uiDir)) {
    const walk = (current: string, prefix: string): string | null => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        const key = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          const failed = walk(full, `${key}/`);
          if (failed) return failed;
          continue;
        }
        if (statSync(full).size > MAX_FILE_BYTES) {
          return `${key} 超过 ${MAX_FILE_BYTES} 字节上限`;
        }
        files[key] = readFileSync(full, 'utf8');
      }
      return null;
    };
    const failed = walk(uiDir, 'ui/');
    if (failed) return { ok: false, error: failed };
  }
  return { ok: true, files };
}

function reject(
  dir: string,
  reason: PluginRejectionReason,
  detail: string,
): PluginInventoryRejection {
  return { dir, reason, detail };
}

const TRUST_REJECTIONS: Partial<Record<PackageTrust, PluginRejectionReason>> = {
  tampered: 'tampered',
  unsigned: 'unsigned',
  'unknown-signer': 'untrusted-signer',
};

export function exactKeyOf(id: string, version: string): string {
  return `${id}@${version}`;
}

/**
 * 扫描安装目录。
 *
 * 目录不存在等价于「一个外置插件都没装」，不是错误：基础包首次启动就是这个状态。
 */
export function scanPluginInventory(options: ScanOptions): PluginInventory {
  const inventory: PluginInventory = { entries: [], rejected: [] };

  let dirNames: string[];
  try {
    dirNames = readdirSync(options.pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return inventory;
  }

  const taken = new Set(options.reservedKeys ?? []);

  for (const name of dirNames) {
    const dir = join(options.pluginsDir, name);

    let read: ReadResult;
    try {
      read = readPackageFiles(dir);
    } catch (error) {
      read = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!read.ok) {
      inventory.rejected.push(reject(name, 'unreadable', read.error));
      continue;
    }
    const files = read.files;

    const issues = validatePluginPackage(files);
    if (issues.length > 0) {
      inventory.rejected.push(
        reject(
          name,
          'invalid-package',
          issues.map((issue) => `${issue.path}: ${issue.message}`).join('；'),
        ),
      );
      continue;
    }

    const parsed = parsePluginPackage(files);
    const { id, version } = parsed.manifest;

    // 静态隔离扫描（§13.4 第二层）：代码资产带宿主越权访问的包直接拒装
    if (parsed.codeAssets) {
      const violations = scanPluginSources(parsed.codeAssets);
      if (violations.length > 0) {
        inventory.rejected.push(
          reject(
            name,
            'isolation-violation',
            violations.map((violation) => `${violation.path}: ${violation.reason}`).join('；'),
          ),
        );
        continue;
      }
    }

    // 目录名必须自证身份，否则同一个包换个目录名就能装两遍，卸载也找不准
    if (name !== exactKeyOf(id, version)) {
      inventory.rejected.push(
        reject(name, 'directory-mismatch', `目录名应为 ${exactKeyOf(id, version)}`),
      );
      continue;
    }

    const trust = classifyPackageTrust(files, options.trustedPublicKeys);
    const trustRejection = TRUST_REJECTIONS[trust];
    if (trustRejection) {
      inventory.rejected.push(reject(name, trustRejection, `签名判定：${trust}`));
      continue;
    }

    if (taken.has(name)) {
      inventory.rejected.push(reject(name, 'duplicate', `${name} 已被内置或另一个包占用`));
      continue;
    }
    taken.add(name);

    inventory.entries.push({ dir, trust, package: parsed });
  }

  return inventory;
}
