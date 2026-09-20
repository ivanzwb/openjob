/**
 * 启动时装载外置插件。
 *
 * 单独一层是为了让 runtime.ts 保持无副作用、可直接单测：扫盘、找密钥、打日志都在这里，
 * runtime.ts 只接收结果。
 */
import type { PluginInventoryView } from '@core/ipc';
import { getAppPaths } from '../paths';
// 直接引 bridge 而非 ipc/index，避免与 handler 注册形成循环依赖（同 llm/index.ts）
import { emit } from '../ipc/bridge';
import { scanPluginInventory, type PluginInventory } from './inventory';
import { loadTrustedPublicKeys } from './package/trustedKeys';
import {
  listExternalPlugins,
  setExternalPlugins,
} from './runtime';
import { getRawDb } from '../db';
import { backfillPrePluginCampaignRuntime } from '../db/backfill/pluginRuntime';
import { selectPrePluginRolePack } from '@core/planner/contributions';

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
  });

  setExternalPlugins(inventory.entries);
  lastInventory = inventory;

  // 岗位包装载后重跑旧战役回填：回填在插件未装时会跳过（不写 checkpoint），
  // 装包后的这一次扫描让旧战役立刻拿到 descriptor，而不是等下一次启动
  try {
    backfillPrePluginCampaigns();
  } catch (error) {
    console.warn('旧战役插件运行时回填失败：', error);
  }

  // 盘上的包变了就广播一次：安装成功、卸载、删掉被拒目录都各自调用本函数，所以那三处
  // 不必再各发一次，事件从这里统一出去。载荷只报装了几个包，不掺任何岗位词汇。
  emit('plugin:inventory-changed', { count: inventory.entries.length });

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

/**
 * 渲染层视图：盘上装了什么、以及装不上的包和原因。
 *
 * 只反映扫描结果（真有那几个目录），不掺运行时合成的能力条目——后者不是用户装的包。
 */
export function pluginInventoryView(): PluginInventoryView {
  return {
    installed: lastInventory.entries.map((entry) => ({
      id: entry.package.manifest.id,
      version: entry.package.manifest.version,
      type: entry.package.manifest.type,
      displayName: entry.package.manifest.displayName,
      description: entry.package.manifest.description,
      trust: entry.trust,
      main: entry.package.manifest.main ?? null,
    })),
    rejected: lastInventory.rejected.map((item) => ({
      dir: item.dir,
      reason: item.reason,
      detail: item.detail,
    })),
  };
}


/**
 * 旧战役回填（插件化之前的 Campaign）：descriptor 从当前安装的、声明了材料型任务的
 * 那个岗位包构建（基础包不点名岗位族）。包未安装时内部会跳过且不写 checkpoint，
 * 装包后的下一次装载/安装事件重试。
 */
export function backfillPrePluginCampaigns(): void {
  const pack = selectPrePluginRolePack(
    listExternalPlugins()
      .map((entry) => entry.package.rolePack)
      .filter((item): item is NonNullable<typeof item> => item !== undefined),
  );
  if (!pack) return;
  backfillPrePluginCampaignRuntime(getRawDb(), { pack });
}