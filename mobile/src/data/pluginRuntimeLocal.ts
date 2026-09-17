/**
 * 代码插件在移动端的数据层（§12.5 移动端消费模型）。
 *
 * 代码插件不单独安装：它的声明与资产都内联在岗位包数据里（RolePack.codeAssets），
 * 随 role_pack_cache 从桌面同步过来。这里只做三件事：
 *
 * 1. 从缓存里找出带移动端实现的岗位包 = 找出移动端可用的代码插件；
 * 2. 岗位包类型的代码入口随岗位启用（选岗即确认），独立 plugin 类型目前
 *    没有移动端确认通道，不上屏；
 * 3. 把 mobile/main.js 声明的页面（WebView shim 运行时收集）与 ui 资产配好对，
 *    交给 PluginRuntimesScreen 的 WebView 运行时。
 *
 * 桥协议与桌面同构：页面内 postMessage → RN onMessage → invokeRemote 转发
 * 桌面白名单通道。桌面侧权限网关仍逐次校验，移动端只是传输层。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { selectPlatformAssets } from '@core/plugins/package/contract';
import type { RolePack } from '@core/plugins/types';
import { listCachedRolePacks } from './rolePackLocal';

export interface MobilePluginRuntimePage {
  pluginId: string;
  fullId: string;
  id: string;
  title: string;
  webviewPath: string;
}

export interface MobilePluginRuntime {
  pluginId: string;
  version: string;
  displayName: string;
  permissions: string[];
  pages: MobilePluginRuntimePage[];
  uiAssets: Record<string, string>;
  mainSource: string;
}

/** 从缓存里找出带移动端实现的代码插件。缺 mobile/ 那份的包在移动端不上屏，跳过不炸列表。 */
export function listMobilePluginRuntimes(db: SQLiteDatabase): MobilePluginRuntime[] {
  return listCachedRolePacks(db).flatMap((pack) => {
    // 剥掉平台前缀：拿到的键是 main.js 与 ui/**，与插件源码里的 webviewPath 同构
    const platformAssets = selectPlatformAssets(pack.codeAssets, 'mobile');
    if (!platformAssets) return [];
    const manifest = (pack as RolePack).manifest;
    return [
      {
        pluginId: manifest.id,
        version: manifest.version,
        displayName: manifest.displayName,
        permissions: [...manifest.permissions],
        pages: [] as MobilePluginRuntimePage[],
        uiAssets: platformAssets.uiAssets,
        mainSource: platformAssets.source,
      },
    ];
  });
}
