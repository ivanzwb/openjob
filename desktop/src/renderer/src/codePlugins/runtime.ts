/**
 * 代码插件激活（§7.9）：渲染进程内加载入口（Obsidian 同构），API 走 IPC 桥。
 *
 * 加载机制：入口源码经 `plugin:getEntrySource` 取回（主进程已做过安装期隔离
 * 扫描），在函数体内以 CommonJS 形式执行——`require('openjob')` 是插件拿到
 * 宿主能力的唯一途径。插件代码运行在渲染层的页面沙箱里，没有 Node 能力。
 */
import { useEffect, useState } from 'react';
import {
  activateCodePlugin,
  createEventHub,
  type ActiveCodePlugin,
  type CodePluginModule,
} from '@core/plugins/codePlugin/host';
import type { LlmRole } from '@core/enums';
import { invoke } from '../ipc';

const hub = createEventHub();
let active: ActiveCodePlugin[] = [];
const uiAssetsByPlugin = new Map<string, Record<string, string>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeCodePlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveCodePlugins(): ActiveCodePlugin[] {
  return active;
}

export function getUiAssets(pluginId: string): Record<string, string> {
  return uiAssetsByPlugin.get(pluginId) ?? {};
}

/** CommonJS 装配：`require('openjob')` 是插件拿到宿主门面的唯一入口 */
function loadModule(
  source: string,
  pluginId: string,
  version: string,
  permissions: readonly string[],
): CodePluginModule {
  const module = { exports: {} as Partial<CodePluginModule> };
  // 权限即 API 面：未声明的命名空间不注入（§7.9）
  const facade: Record<string, unknown> = {
    storage: {
      get: (key: string) => invoke('codePlugin:storage.get', { pluginId, key }),
      set: (key: string, value: string) => invoke('codePlugin:storage.set', { pluginId, key, value }),
      delete: (key: string) => invoke('codePlugin:storage.delete', { pluginId, key }),
    },
    campaign: {
      getDescriptor: async (campaignId: string) =>
        (await invoke('campaign:getRuntimeDescriptor', { campaignId }))?.descriptor ?? null,
    },
  };
  if (permissions.includes('llm:complete')) {
    facade.llm = {
      complete: (request: { system: string; user: string; role?: LlmRole }) =>
        invoke('codePlugin:llm.complete', {
          pluginId,
          version,
          ...request,
        }),
    };
  }
  if (permissions.includes('evidence:read-confirmed')) {
    facade.evidence = {
      listConfirmed: (campaignId: string) =>
        invoke('codePlugin:evidence.listConfirmed', { pluginId, campaignId }),
    };
  }
  const requireShim = (id: string): unknown => {
    if (id === 'openjob') return facade;
    throw new Error(`插件只允许 require('openjob')，实际请求了 ${id}`);
  };
  new Function('module', 'exports', 'require', source)(module, module.exports, requireShim);
  const loaded = module.exports as CodePluginModule;
  if (typeof loaded?.activate !== 'function') {
    throw new Error(`插件 ${pluginId} 的入口缺少 activate(ctx)`);
  }
  return loaded;
}

/** 激活全部「已确认启用」的代码插件；单个失败不阻断其余（错误进 console 供诊断） */
export async function activateInstalledCodePlugins(): Promise<void> {
  const codePlugins = await invoke('codePlugin:list', undefined);
  const next: ActiveCodePlugin[] = [];

  for (const plugin of codePlugins.filter((item) => item.enabled)) {
    try {
      const entry = await invoke('plugin:getEntrySource', {
        id: plugin.id,
        version: plugin.version,
      });
      if (!entry) continue;
      uiAssetsByPlugin.set(plugin.id, entry.uiAssets);
      next.push(
        activateCodePlugin({
          pluginId: plugin.id,
          version: plugin.version,
          module: loadModule(entry.source, plugin.id, plugin.version, plugin.permissions),
          services: {
            campaign: {
              getDescriptor: async (campaignId) =>
                (await invoke('campaign:getRuntimeDescriptor', { campaignId }))?.descriptor ?? null,
            },
            storage: {
              get: (key) => invoke('codePlugin:storage.get', { pluginId: plugin.id, key }),
              set: (key, value) =>
                invoke('codePlugin:storage.set', { pluginId: plugin.id, key, value }),
              delete: (key) => invoke('codePlugin:storage.delete', { pluginId: plugin.id, key }),
            },
          },
          hub,
        }),
      );
    } catch (error) {
      console.error(`[codePlugin] 激活失败：${plugin.id}@${plugin.version}`, error);
    }
  }

  // 重新激活 = 全量替换：撤掉旧集合里不在新集合中的插件
  const nextIds = new Set(next.map((item) => item.pluginId));
  for (const previous of active) {
    if (!nextIds.has(previous.pluginId)) previous.deactivate();
  }
  active = next;
  notify();
}

/** React 订阅：代码插件页签 */
export function useCodePluginTabs(): ActiveCodePlugin[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return active;
}

export function activateOnMount(): void {
  useEffect(() => {
    void activateInstalledCodePlugins();
  }, []);
}

export { hub as codePluginEventHub };

/** 启用：主进程落确认记录后，立即重新激活让页签即时出现 */
export async function enableCodePlugin(id: string): Promise<void> {
  await invoke('codePlugin:setEnabled', { id, enabled: true });
  await activateInstalledCodePlugins();
}

/** 停用：撤贡献断桥，页签即时消失；确认记录保留（再次启用不再重复确认） */
export async function disableCodePlugin(id: string): Promise<void> {
  await invoke('codePlugin:setEnabled', { id, enabled: false });
  await activateInstalledCodePlugins();
}
