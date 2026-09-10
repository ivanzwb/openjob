/**
 * 启动时装载外置插件。
 *
 * 单独一层是为了让 runtime.ts 保持无副作用、可直接单测：扫盘、找密钥、打日志都在这里，
 * runtime.ts 只接收结果。
 */
import type { PluginInventoryView } from '@shared/ipc';
import { getAppPaths } from '../paths';
import { scanPluginInventory, type PluginInventory } from './inventory';
import { loadTrustedPublicKeys } from './package/trustedKeys';
import { builtInPluginKeys, setExternalPlugins } from './runtime';

let lastInventory: PluginInventory = { entries: [], rejected: [] };

/**
 * 扫描并装载。
 *
 * 装载失败的包不静默丢弃：一个装了却没生效的插件，用户能看到的只有「岗位列表里没有
 * 它」，日志里必须留下原因。
 */
export function loadExternalPlugins(): PluginInventory {
  const inventory = scanPluginInventory({
    pluginsDir: getAppPaths().pluginsDir,
    trustedPublicKeys: loadTrustedPublicKeys(),
    reservedKeys: builtInPluginKeys(),
  });

  setExternalPlugins(inventory.entries);
  lastInventory = inventory;

  if (inventory.rejected.length > 0) {
    console.warn(
      '以下外置插件未装载：',
      inventory.rejected.map((item) => `${item.dir}（${item.reason}）${item.detail}`),
    );
  }
  return inventory;
}

/** 最近一次扫描结果。 */
export function getPluginInventory(): PluginInventory {
  return lastInventory;
}

/** 渲染层视图：装上了什么、以及装不上的包和原因。 */
export function pluginInventoryView(): PluginInventoryView {
  return {
    installed: lastInventory.entries.map((entry) => ({
      id: entry.package.manifest.id,
      version: entry.package.manifest.version,
      type: entry.package.manifest.type,
      trust: entry.trust,
    })),
    rejected: lastInventory.rejected.map((item) => ({
      dir: item.dir,
      reason: item.reason,
      detail: item.detail,
    })),
  };
}
