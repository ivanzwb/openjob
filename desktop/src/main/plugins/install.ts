/**
 * 安装与卸载外置插件。
 *
 * 分发容器是一个 JSON 信封（可 gzip），不是 zip。包内文件全是文本，用不上归档格式；而
 * 引入 zip 解析器等于把 P01–P03 刚消掉的攻击面请回来——zip-slip（条目名里带 ../ 写到目录
 * 外）是这类漏洞的经典形态。信封里的键在写盘之前先过白名单，连路径分隔符都不可能出现。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  PACKAGE_ALLOWED_FILES,
  validatePluginPackage,
  type PluginPackageFiles,
  parsePluginPackage,
} from '@core/plugins/package/contract';
import { PRE_PLUGIN_DEFAULT_ROLE_PACK_ID } from '@core/planner/contributions';
import { scanPluginSources } from '@core/plugins/pluginRuntime/scan';
import { getAppPaths } from '../paths';
import { loadExternalPlugins } from './bootstrap';
import { exactKeyOf } from './inventory';
import { classifyPackageTrust, type PackageTrust } from './package/signature';
import { loadTrustedPublicKeys } from './package/trustedKeys';
import { builtInPluginKeys, listExternalPlugins } from './runtime';

export const BUNDLE_EXTENSION = '.openjob.json';

/**
 * 信封解压后的大小上限。
 *
 * gzip 炸弹能用几十 KB 展开成几 GB。zlib 的 maxOutputLength 在超限时直接报错，
 * 不会先把内存吃光。清单下载也复用这个上限：包体从网络来，边界得和本地文件一致。
 */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const GZIP_MAGIC = [0x1f, 0x8b];

export type InstallFailureCode =
  | 'unreadable-bundle'
  | 'invalid-bundle'
  | 'invalid-package'
  | 'tampered'
  | 'unsigned'
  | 'untrusted-signer'
  | 'reserved-id'
  | 'already-installed'
  | 'one-plugin-limit'
  | 'isolation-violation'
  | 'confirm-data-loss';

export type InstallResult =
  | { ok: true; id: string; version: string; trust: PackageTrust }
  | { ok: false; code: InstallFailureCode; detail: string };

interface InstallOptions {
  /** 用户在「来源不受信任」提示上点了确认。第一方签名的包不需要这个。 */
  trustUnknownSigner?: boolean;
  /** 已装同一个 id@version 时覆盖。 */
  overwrite?: boolean;
  /** 用户在「升级前旧战役数据可能丢失」提示上点了继续。 */
  confirmDataLoss?: boolean;
  /**
   * 主进程注入：本机尚未映射岗位的插件化之前旧战役数。缺省视为 0，
   * 不触发数据丢失把关（测试与无库场景不感知 DB）。
   */
  countPendingPrePluginCampaigns?: () => number;
}

function fail(code: InstallFailureCode, detail: string): InstallResult {
  return { ok: false, code, detail };
}

/** 解析分发信封。任何一步不对都拒，不做"尽力恢复"。 */
export function parseBundle(raw: Buffer): { ok: true; files: PluginPackageFiles } | { ok: false; detail: string } {
  let text: string;
  try {
    const isGzip = raw.length >= 2 && GZIP_MAGIC.every((byte, index) => raw[index] === byte);
    text = isGzip
      ? gunzipSync(raw, { maxOutputLength: MAX_BUNDLE_BYTES }).toString('utf8')
      : raw.toString('utf8');
  } catch (error) {
    return { ok: false, detail: `解压失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (text.length > MAX_BUNDLE_BYTES) return { ok: false, detail: '信封超过大小上限' };

  let parsed: { files?: unknown };
  try {
    parsed = JSON.parse(text) as { files?: unknown };
  } catch (error) {
    return { ok: false, detail: `不是合法 JSON：${(error as Error).message}` };
  }
  const entries = parsed.files;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    return { ok: false, detail: '信封缺少 files 对象' };
  }

  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(entries)) {
    // 白名单先行：标准文件限死成常量；代码插件另允许 main.js 与 ui/<安全文件名>
    // （是否真的允许由 manifest.main 决定，格式校验里还会再验一遍）。
    // 名字里不允许路径分隔符或 ..，路径穿越无从谈起
    const isAllowedCodeAsset =
      name === 'main.js' || (/^ui\//.test(name) && !name.includes('..'));
    if (!PACKAGE_ALLOWED_FILES.includes(name) && !isAllowedCodeAsset) {
      return { ok: false, detail: `信封里出现未知文件：${name}` };
    }
    if (typeof content !== 'string') return { ok: false, detail: `${name} 的内容必须是字符串` };
    files[name] = content;
  }
  return { ok: true, files };
}

function writeAtomically(target: string, files: PluginPackageFiles): void {
  // 先写到同一分区的临时目录再整体 rename：中途失败不会在 plugins/ 下留一个半截包，
  // 而半截包会被扫描当成「格式不合法」，用户看到的是一条与真实原因无关的报错。
  // 暂存目录放在 plugins/ 之外，否则崩溃残留下来的暂存目录自己就会被扫成坏包。
  const paths = getAppPaths();
  mkdirSync(paths.pluginsDir, { recursive: true });
  const stagingRoot = join(paths.userData, '.plugin-staging');
  mkdirSync(stagingRoot, { recursive: true });
  const staging = mkdtempSync(join(stagingRoot, 'pkg-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(staging, name);
      // ui/ 等子路径资产：先建父目录
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 用户显式信任过的签名者，设备本地，不同步。 */
function trustStorePath(): string {
  return join(getAppPaths().userData, 'plugin-trust.json');
}

function consentedSigners(): string[] {
  const path = trustStorePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { signers?: unknown };
    return Array.isArray(parsed.signers)
      ? parsed.signers.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function trustSigner(publicKeyPem: string): void {
  const signers = new Set(consentedSigners());
  signers.add(publicKeyPem);
  writeFileSync(trustStorePath(), JSON.stringify({ signers: [...signers] }, null, 2), 'utf8');
}

export function installPluginBundle(raw: Buffer, options: InstallOptions = {}): InstallResult {
  const bundle = parseBundle(raw);
  if (!bundle.ok) return fail('invalid-bundle', bundle.detail);
  const files = bundle.files;

  // 先验签再解释内容。反过来的话，一个被改过的包会报「格式不合法」——既误导用户
  // （这是安全信号，不是格式问题），也让复杂的格式校验器先去啃未认证的数据。
  // 信任判定用「第一方密钥 + 用户已确认的签名者」：装过一次的第三方发布者不必反复确认，
  // 但确认这件事必须发生过。
  const trust = classifyPackageTrust(files, [...loadTrustedPublicKeys(), ...consentedSigners()]);
  if (trust === 'tampered') return fail('tampered', '内容与签名不符');
  if (trust === 'unsigned') return fail('unsigned', '包没有签名');
  if (trust === 'unknown-signer' && !options.trustUnknownSigner) {
    return fail('untrusted-signer', '签名者不在信任列表，需要用户确认');
  }

  const issues = validatePluginPackage(files);
  if (issues.length > 0) {
    return fail(
      'invalid-package',
      issues.map((issue) => `${issue.path}: ${issue.message}`).join('；'),
    );
  }

  // 静态隔离扫描（§13.4 第二层）：装载期还有同一道，但拒装应该发生在安装时，
  // 让发布者/用户当场看到违规清单，而不是装完之后发现包被装载扫描拒了
  const parsedForScan = parsePluginPackage(files);
  if (parsedForScan.codeAssets) {
    const violations = scanPluginSources(parsedForScan.codeAssets);
    if (violations.length > 0) {
      return fail(
        'isolation-violation',
        violations.map((violation) => `${violation.path}: ${violation.reason}`).join('；'),
      );
    }
  }

  const manifest = JSON.parse(files['manifest.json']!) as { id: string; version: string; type?: string };
  const key = exactKeyOf(manifest.id, manifest.version);

  if (builtInPluginKeys().has(key)) {
    return fail('reserved-id', `${key} 与内置插件冲突`);
  }

  // 一台设备只装一个插件包。这是宿主的产品规则，不是包格式的一部分，所以守卫落在安装这个
  // 唯一入口上：文件对话框与更新源清单两条路都从这里进，谁都不会绕过去。
  // 同一个 id 的另一个版本不算「另一个插件」——那是升级或回退，沿用原有的并存行为。
  const other = listExternalPlugins().find((entry) => entry.package.manifest.id !== manifest.id);
  if (other) {
    const current = other.package.manifest;
    return fail(
      'one-plugin-limit',
      `本机已装 ${current.id}@${current.version}。插件只支持装一个：先卸载它，再装这个。`,
    );
  }

  // 数据丢失把关：插件化升级前的旧战役全是软件工程语义。装默认岗位包之外的角色包，
  // 旧数据不会自动变成新岗位——用户若把新岗位套用到旧战役，原面试数据会丢失。库里
  // 还有这类待映射战役时先让用户确认，而不是装完让用户自己踩坑。
  // 装默认岗位包（软件工程）不拦：那正是让旧数据恢复原功能的路径。
  if (
    !options.confirmDataLoss &&
    options.countPendingPrePluginCampaigns !== undefined &&
    manifest.type === 'role-pack' &&
    manifest.id !== PRE_PLUGIN_DEFAULT_ROLE_PACK_ID
  ) {
    const pending = options.countPendingPrePluginCampaigns();
    if (pending > 0) {
      return fail(
        'confirm-data-loss',
        `本机还有 ${pending} 场插件化升级前的软件工程战役尚未映射岗位。` +
          '安装这个角色包本身不会改动它们，但之后若把新岗位应用到旧战役，原有面试数据将无法保留。',
      );
    }
  }

  const target = join(getAppPaths().pluginsDir, key);
  if (existsSync(target) && !options.overwrite) {
    return fail('already-installed', `${key} 已安装`);
  }

  writeAtomically(target, files);
  loadExternalPlugins();

  return { ok: true, id: manifest.id, version: manifest.version, trust };
}

export function installPluginFromFile(path: string, options: InstallOptions = {}): InstallResult {
  try {
    return installPluginBundle(readFileSync(path), options);
  } catch (error) {
    return fail('unreadable-bundle', error instanceof Error ? error.message : String(error));
  }
}

/** 卸载。幂等：没装过也算成功，调用方不必先查。 */
export function uninstallPlugin(id: string, version: string): { removed: boolean } {
  const key = exactKeyOf(id, version);
  const target = join(getAppPaths().pluginsDir, key);
  const existed = existsSync(target);
  rmSync(target, { recursive: true, force: true });
  loadExternalPlugins();
  return { removed: existed };
}
