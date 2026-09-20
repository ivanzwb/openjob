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
 * 目录定位与 trustedKeys 同一套（打包后 extraResources 把 resources/ 铺在 resourcesPath 下，
 * 开发期回落 `resources/`），刻意不 import electron，本模块可以直接单测。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAppPaths } from '../paths';
import { dismissedPluginIds } from './dismissedPlugins';
import { installPluginBundle } from './install';

const DIR_NAME = 'default-plugins';
const BUNDLE_EXTENSION = '.ojb';
/** 产物命名是 `<id>@<version>.ojb`（见 scripts/pack-plugins.mjs）：包的身份从文件名读，不写死在源码里。 */
const BUNDLE_NAME = /^(.+)@(.+)\.ojb$/;

export function bundledDefaultPluginDirs(): string[] {
  const dirs: string[] = [];
  if (process.resourcesPath) dirs.push(join(process.resourcesPath, DIR_NAME));
  dirs.push(join(process.cwd(), 'resources', DIR_NAME));
  return dirs;
}

/** 随包分发的 bundle；开发期没打包就没有，此时什么都不做。 */
function bundledBundles(dirs: readonly string[]): Array<{ id: string; path: string }> {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const found = readdirSync(dir)
      .filter((name) => name.endsWith(BUNDLE_EXTENSION))
      .sort()
      .map((name) => ({ id: BUNDLE_NAME.exec(name)?.[1] ?? '', path: join(dir, name) }))
      .filter((bundle) => bundle.id.length > 0);
    if (found.length > 0) return found;
  }
  return [];
}

/** 本机是否已经装着这个 id 的任一版本。看盘而不是看上一次扫描结果：装机时扫描还没跑过。 */
function hasInstalledVersion(pluginsDir: string, id: string): boolean {
  if (!existsSync(pluginsDir)) return false;
  return readdirSync(pluginsDir).some((name) => name.startsWith(`${id}@`));
}

/**
 * 确保随包分发的默认插件在本机装着。幂等：已经装着（含用户自己装的同一个包）就什么都不做。
 *
 * 只装，不覆盖：本机已有该 id 的其它版本时那是用户的选择或升级，默认包不去动它。
 * 用户主动卸载过它就再也不装——默认不等于删不掉。
 */
export function ensureBundledDefaultPlugin(
  dirs: readonly string[] = bundledDefaultPluginDirs(),
): void {
  const { pluginsDir } = getAppPaths();
  const dismissed = dismissedPluginIds();

  for (const bundle of bundledBundles(dirs)) {
    if (dismissed.has(bundle.id)) continue;
    if (hasInstalledVersion(pluginsDir, bundle.id)) continue;

    const result = installPluginBundle(readFileSync(bundle.path));
    if (!result.ok) {
      // 装不上不该拦住启动：用户已经装了别的岗位包时「一台设备只装一个包」会先拦下来，那是预期
      console.warn(`默认插件未安装：${bundle.path}（${result.code}：${result.detail}）`);
    }
  }
}
