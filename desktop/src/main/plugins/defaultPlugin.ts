/**
 * 随安装包一起分发的默认插件。
 *
 * 插件化之前建的战役都挂在某一个岗位包上（带材料的源码任务、旧题型与旧 Prompt 引用），
 * 装不上对应的包它们就没有运行配置、只能只读。为了升级上来的用户开箱即用，安装包里带一份
 * 签名过的岗位包 bundle，启动时若本机没有它的任何版本就装进 `pluginsDir`。
 *
 * 基础包因此仍然不认识任何一个岗位：这里只认「随包分发的那份 bundle」，是哪个岗位包由
 * bundle 自己的文件名说了算，源码里没有岗位簇的名字（见 hostUi/roleNeutralGate）。
 *
 * 走的是与用户手装完全相同的一条路（验签 → 隔离扫描 → 落盘 → 重新装载），所以它没有特殊
 * 身份：能被卸载，卸载过就不再回来（见 dismissedPlugins.ts），也照样受「一台设备只装一个包」
 * 约束——用户换成别的岗位包之后，这里会因为那条规则装不进去。装不上只记一条 warn，绝不拦启动。
 *
 * 装的是「本机还没有的那份内容」：没装过就装，装着更老的版本就升上去，同版本但安装包里那份
 * 内容变了就换上去——包内容（页面声明、题型、量规、片段）随安装包迭代，而包版本号不一定跟着
 * 走，只比版本号等于修好的东西永远送不到老用户手上。反过来本机装着更新的版本时不动它：
 * 那是用户自己的升级或回退，默认包不倒着覆盖。
 *
 * 目录定位与 trustedKeys 同一套（打包后 extraResources 把 resources/ 铺在 resourcesPath 下，
 * 开发期回落 `resources/`），刻意不 import electron，本模块可以直接单测。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareVersions } from '@core/version';
import { getAppPaths } from '../paths';
import { dismissedPluginIds } from './dismissedPlugins';
import { installPluginBundle } from './install';

const DIR_NAME = 'default-plugins';
const BUNDLE_EXTENSION = '.ojb';
const STATE_FILE_NAME = 'bundled-plugins.json';
/** 产物命名是 `<id>@<version>.ojb`（见 scripts/pack-plugins.mjs）：包的身份从文件名读，不写死在源码里。 */
const BUNDLE_NAME = /^(.+)@(.+)\.ojb$/;

export function bundledDefaultPluginDirs(): string[] {
  const dirs: string[] = [];
  if (process.resourcesPath) dirs.push(join(process.resourcesPath, DIR_NAME));
  dirs.push(join(process.cwd(), 'resources', DIR_NAME));
  return dirs;
}

/** 随包分发的 bundle；开发期没打包就没有，此时什么都不做。 */
function bundledBundles(
  dirs: readonly string[],
): Array<{ id: string; version: string; path: string }> {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const found = readdirSync(dir)
      .filter((name) => name.endsWith(BUNDLE_EXTENSION))
      .sort()
      .map((name) => {
        const matched = BUNDLE_NAME.exec(name);
        return { id: matched?.[1] ?? '', version: matched?.[2] ?? '', path: join(dir, name) };
      })
      .filter((bundle) => bundle.id.length > 0 && bundle.version.length > 0);
    if (found.length > 0) return found;
  }
  return [];
}

/** 本机装着这个 id 的哪些版本。看盘而不是看上一次扫描结果：装机时扫描还没跑过。 */
function installedVersions(pluginsDir: string, id: string): string[] {
  if (!existsSync(pluginsDir)) return [];
  const prefix = `${id}@`;
  return readdirSync(pluginsDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
}

/**
 * 该不该把这份随包分发的 bundle 装上去，装的话要不要覆盖同版本的目录。
 *
 * 本机装着更新的版本时什么都不做（那是用户自己的升级或回退）；同版本时只有内容变了才重装——
 * 安装包里那份是权威，但没必要每次启动重写一遍盘。
 */
export function bundledInstallAction(
  bundledVersion: string,
  bundleHash: string,
  installed: readonly string[],
  lastInstalledHash: string | undefined,
): { install: boolean; overwrite: boolean } {
  if (installed.length === 0) return { install: true, overwrite: false };

  const newest = [...installed].sort(compareVersions).at(-1) ?? '';
  const order = compareVersions(bundledVersion, newest);
  if (order < 0) return { install: false, overwrite: false };
  if (order > 0) return { install: true, overwrite: false };

  return { install: lastInstalledHash !== bundleHash, overwrite: true };
}

function statePath(): string {
  return join(getAppPaths().userData, STATE_FILE_NAME);
}

/**
 * 上一次由本机装上去的那份 bundle 的内容哈希（id → sha256）。
 *
 * 文件坏掉按「没装过」处理：那样最多多装一次，不会因为一个坏文件把修复过的包挡在门外——
 * 方向与 dismissedPlugins 一致。
 */
function lastInstalledHashes(path = statePath()): Map<string, string> {
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { installed?: unknown };
    const entries = Array.isArray(parsed.installed) ? parsed.installed : [];
    return new Map(
      entries.flatMap((entry) => {
        const pair = entry as { id?: unknown; sha256?: unknown };
        return typeof pair.id === 'string' && typeof pair.sha256 === 'string'
          ? [[pair.id, pair.sha256] as [string, string]]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}

function rememberInstalledHash(id: string, sha256: string, path = statePath()): void {
  const merged = { ...Object.fromEntries(lastInstalledHashes(path)), [id]: sha256 };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        installed: Object.entries(merged)
          .map(([key, value]) => ({ id: key, sha256: value }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * 确保随包分发的默认插件在本机装着、且内容是安装包里那一份。
 *
 * 用户主动卸载过它就再也不装——默认不等于删不掉。
 */
export function ensureBundledDefaultPlugin(
  dirs: readonly string[] = bundledDefaultPluginDirs(),
): void {
  const { pluginsDir } = getAppPaths();
  const dismissed = dismissedPluginIds();
  const hashes = lastInstalledHashes();

  for (const bundle of bundledBundles(dirs)) {
    if (dismissed.has(bundle.id)) continue;

    const raw = readFileSync(bundle.path);
    const hash = createHash('sha256').update(raw).digest('hex');
    const action = bundledInstallAction(
      bundle.version,
      hash,
      installedVersions(pluginsDir, bundle.id),
      hashes.get(bundle.id),
    );
    if (!action.install) continue;

    const result = installPluginBundle(raw, { overwrite: action.overwrite });
    if (!result.ok) {
      // 装不上不该拦住启动：用户已经装了别的岗位包时「一台设备只装一个包」会先拦下来，那是预期
      console.warn(`默认插件未安装：${bundle.path}（${result.code}：${result.detail}）`);
      continue;
    }
    rememberInstalledHash(bundle.id, hash);
  }
}
