/**
 * 安装与卸载外置插件。
 *
 * 分发容器 `.ojb` 是 gzip 压缩的 JSON 信封，不是 zip，也不接受裸 JSON。包内文件全是文本，
 * 用不上归档格式；而引入 zip 解析器等于把 P01–P03 刚消掉的攻击面请回来——zip-slip（条目名
 * 里带 ../ 写到目录外）是这类漏洞的经典形态。信封里的键在写盘之前先过白名单，连路径分隔符
 * 都不可能出现。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  isCodeAssetName,
  PACKAGE_ALLOWED_FILES,
  validatePluginPackage,
  type PluginPackageFiles,
  parsePluginPackage,
} from '@core/plugins/package/contract';
import { isPrePluginRolePack } from '@core/planner/contributions';
import { scanPluginSources } from '@core/plugins/pluginRuntime/scan';
import { getAppPaths } from '../paths';
import { loadExternalPlugins } from './bootstrap';
import { dismissPlugin } from './dismissedPlugins';
import { exactKeyOf } from './inventory';
import { classifyPackageTrust, type PackageTrust } from './package/signature';
import { loadTrustedPublicKeys } from './package/trustedKeys';
import { listExternalPlugins } from './runtime';

/** 分发容器扩展名。文件名是 `<id>@<version>.ojb`，内容是 gzip 压缩的 JSON 信封。 */
export const BUNDLE_EXTENSION = '.ojb';

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

/** 解析分发容器 `.ojb`。任何一步不对都拒，不做"尽力恢复"。 */
export function parseBundle(raw: Buffer): { ok: true; files: PluginPackageFiles } | { ok: false; detail: string } {
  const isGzip = raw.length >= 2 && GZIP_MAGIC.every((byte, index) => raw[index] === byte);
  if (!isGzip) {
    // 裸 JSON 是 v1.0 的旧产物形态。这里不兜：认下来就等于给一个"看起来能装、
    // 其实没签名保护外的那层容器"的口子，报错比默默接受更有用
    return {
      ok: false,
      detail: `不是 ${BUNDLE_EXTENSION} 包：文件头不是 gzip。插件包必须是用打包脚本产出的压缩包。`,
    };
  }

  let text: string;
  try {
    text = gunzipSync(raw, { maxOutputLength: MAX_BUNDLE_BYTES }).toString('utf8');
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
    // 白名单先行：标准文件限死成常量；代码插件另允许各端入口与 ui/<安全文件名>
    // （是否真的允许由 manifest.main/mobile 决定，格式校验里还会再验一遍）。
    // 名字里不允许路径分隔符或 ..，路径穿越无从谈起
    const isAllowedCodeAsset = isCodeAssetName(name) && !name.includes('..');
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

  // 数据丢失把关：插件化升级前的旧战役都是「带材料任务」的形态，只有声明了这种任务的
  // 岗位包才是让旧数据恢复原功能的那一个。装其它角色包时旧数据不会自动变成新岗位——
  // 用户若把新岗位套用到旧战役，原面试数据会丢失；库里还有这类待映射战役就先让用户确认，
  // 而不是装完让用户自己踩坑。
  if (
    !options.confirmDataLoss &&
    options.countPendingPrePluginCampaigns !== undefined &&
    manifest.type === 'role-pack' &&
    !(parsedForScan.rolePack !== undefined && isPrePluginRolePack(parsedForScan.rolePack))
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
  // 卸载过的包记一笔：随安装包分发的默认插件靠它才「删得掉」——否则下次启动会装回来。
  // 不区分是哪个包：基础包不认识任何岗位，这条规则对任何默认插件都成立
  dismissPlugin(id);
  loadExternalPlugins();
  return { removed: existed };
}

/**
 * 删掉一个扫描没通过的插件目录。
 *
 * 被 scanPluginInventory 拒掉的包不进安装清单，因此没有 id@version 可以走 uninstallPlugin；
 * 而目录还占着盘，设置页会一直列在「装在本机但没有生效」里报错。删除只按目录名走，名字
 * 必须先自证是 pluginsDir 的直接子目录（不含分隔符、不是 . / ..）——渲染层若能传路径，
 * 这里就成了任意目录删除器。
 *
 * 幂等：目录不在也算成功，与 uninstallPlugin 一致。
 */
export function removeRejectedPluginDir(dir: string): { removed: boolean } {
  if (dir === '' || dir === '.' || dir === '..' || /[\\/]/.test(dir)) {
    throw new Error(`不合法的插件目录名：${dir}`);
  }
  const target = join(getAppPaths().pluginsDir, dir);
  const existed = existsSync(target);
  rmSync(target, { recursive: true, force: true });
  loadExternalPlugins();
  return { removed: existed };
}
