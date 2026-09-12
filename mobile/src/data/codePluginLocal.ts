/**
 * 代码插件在移动端的数据层（§12.5 移动端消费模型）。
 *
 * 代码插件不单独安装：它的声明与资产都内联在岗位包数据里（RolePack.codeAssets），
 * 随 role_pack_cache 从桌面同步过来。这里只做三件事：
 *
 * 1. 从缓存里找出带代码资产的岗位包 = 找出代码插件；
 * 2. 岗位包类型的代码入口随岗位启用（选岗即确认），独立 plugin 类型目前
 *    没有移动端确认通道，不上屏；
 * 3. 把 main.js 声明的页面（WebView shim 运行时收集）与 ui 资产配好对，
 *    交给 CodePluginsScreen 的 WebView 运行时。
 *
 * 桥协议与桌面同构：页面内 postMessage → RN onMessage → invokeRemote 转发
 * 桌面白名单通道。桌面侧权限网关仍逐次校验，移动端只是传输层。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { listCachedRolePacks } from './rolePackLocal';

export interface MobileCodePluginPage {
  pluginId: string;
  fullId: string;
  id: string;
  title: string;
  webviewPath: string;
}

export interface MobileCodePlugin {
  pluginId: string;
  version: string;
  displayName: string;
  permissions: string[];
  pages: MobileCodePluginPage[];
  uiAssets: Record<string, string>;
  mainSource: string;
}

interface RawCodeAssets {
  'main.js'?: string;
  [assetPath: string]: string | undefined;
}

interface RolePackWithCode {
  manifest: {
    id: string;
    version: string;
    displayName: string;
    permissions: readonly string[];
    main?: string;
  };
  codeAssets?: RawCodeAssets;
}

function isMobileCodePlugin(pack: unknown): pack is RolePackWithCode & { codeAssets: Record<string, string> } {
  if (typeof pack !== 'object' || pack === null) return false;
  const candidate = pack as RolePackWithCode;
  return (
    candidate.manifest?.main !== undefined &&
    typeof candidate.codeAssets?.['main.js'] === 'string'
  );
}

/** 从缓存里找出代码插件。main.js 缺失的声明视为坏包，跳过不炸列表。 */
export function listMobileCodePlugins(db: SQLiteDatabase): MobileCodePlugin[] {
  return listCachedRolePacks(db)
    .filter(isMobileCodePlugin)
    .map((pack) => {
      const codeAssets = pack.codeAssets as Record<string, string>;
      const uiAssets: Record<string, string> = {};
      for (const [name, content] of Object.entries(codeAssets)) {
        if (name.startsWith('ui/')) uiAssets[name] = content;
      }
      return {
        pluginId: pack.manifest.id,
        version: pack.manifest.version,
        displayName: pack.manifest.displayName,
        permissions: [...pack.manifest.permissions],
        pages: [] as MobileCodePluginPage[],
        uiAssets,
        mainSource: codeAssets['main.js'],
      };
    });
}
