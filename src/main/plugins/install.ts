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
} from '@shared/plugins/package/contract';
import { getAppPaths } from '../paths';
import { loadExternalPlugins } from './bootstrap';
import { exactKeyOf } from './inventory';
import { classifyPackageTrust, type PackageTrust } from './package/signature';
import { loadTrustedPublicKeys } from './package/trustedKeys';
import { builtInPluginKeys } from './runtime';

export const BUNDLE_EXTENSION = '.openjob.json';

/**
 * 信封解压后的大小上限。
 *
 * gzip 炸弹能用几十 KB 展开成几 GB。zlib 的 maxOutputLength 在超限时直接报错，
 * 不会先把内存吃光。
 */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const GZIP_MAGIC = [0x1f, 0x8b];

export type InstallFailureCode =
  | 'unreadable-bundle'
  | 'invalid-bundle'
  | 'invalid-package'
  | 'tampered'
  | 'unsigned'
  | 'untrusted-signer'
  | 'reserved-id'
  | 'already-installed';

export type InstallResult =
  | { ok: true; id: string; version: string; trust: PackageTrust }
  | { ok: false; code: InstallFailureCode; detail: string };

interface InstallOptions {
  /** 用户在「来源不受信任」提示上点了确认。第一方签名的包不需要这个。 */
  trustUnknownSigner?: boolean;
  /** 已装同一个 id@version 时覆盖。 */
  overwrite?: boolean;
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
    // 白名单先行：文件名在这里就被限死成四个常量之一，路径穿越无从谈起
    if (!PACKAGE_ALLOWED_FILES.includes(name)) {
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
      writeFileSync(join(staging, name), content, 'utf8');
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

  const manifest = JSON.parse(files['manifest.json']!) as { id: string; version: string };
  const key = exactKeyOf(manifest.id, manifest.version);

  if (builtInPluginKeys().has(key)) {
    return fail('reserved-id', `${key} 与内置插件冲突`);
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
