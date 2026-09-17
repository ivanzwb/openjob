/**
 * 桌面渲染层放行的**通用桥原语表**（分发计划 §11.2 桥自注册）。
 *
 * 键是桥方法名；每一条自带它需要的权限。包在自己的入口代码里声明它要用哪些方法
 * （`ctx.bridge.declare`），宿主按声明放行；声明只决定「这个方法能不能到网关」，
 * 放行与否仍由这里的 `permission` 经权限网关判——**声明 ≠ 有权限**（权威判定在主进程）。
 *
 * 岗位簇方法刻意不在这里：它们是阶段 2 的搬迁对象，暂由
 * `PluginRuntimeWebView` 的 legacy 表兜着，搬走后就只剩这张通用表。
 */
import type { PluginBridgePrimitives } from '@core/plugins/pluginRuntime/bridge';
import { invoke } from '../ipc';

export function desktopBridgePrimitives(pluginId: string): PluginBridgePrimitives {
  return {
    'storage.get': {
      invoke: (params) =>
        invoke('pluginRuntime:storage.get', {
          pluginId,
          key: (params as { key: string }).key,
        }),
    },
    'storage.set': {
      invoke: (params) => {
        const { key, value } = params as { key: string; value: string };
        return invoke('pluginRuntime:storage.set', { pluginId, key, value });
      },
    },
    'storage.delete': {
      invoke: (params) =>
        invoke('pluginRuntime:storage.delete', {
          pluginId,
          key: (params as { key: string }).key,
        }),
    },
    'campaign.getDescriptor': {
      invoke: (params) =>
        invoke('campaign:getRuntimeDescriptor', {
          campaignId: (params as { campaignId: string }).campaignId,
        }),
    },
    'workspace.read': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { path, startLine, endLine } = params as {
          path: string;
          startLine?: number;
          endLine?: number;
        };
        return invoke('pluginRuntime:workspace.read', { pluginId, path, startLine, endLine });
      },
    },
    'workspace.write': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { path, content } = params as { path: string; content: string };
        return invoke('pluginRuntime:workspace.write', { pluginId, path, content });
      },
    },
    'workspace.delete': {
      permission: 'filesystem:workspace',
      invoke: (params) =>
        invoke('pluginRuntime:workspace.delete', {
          pluginId,
          path: (params as { path: string }).path,
        }),
    },
    'workspace.list': {
      permission: 'filesystem:workspace',
      invoke: (params) =>
        invoke('pluginRuntime:workspace.list', {
          pluginId,
          path: (params as { path?: string }).path ?? '.',
        }),
    },
    'workspace.glob': {
      permission: 'filesystem:workspace',
      invoke: (params) =>
        invoke('pluginRuntime:workspace.glob', {
          pluginId,
          pattern: (params as { pattern: string }).pattern,
        }),
    },
    'workspace.grep': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { pattern, path } = params as { pattern: string; path?: string };
        return invoke('pluginRuntime:workspace.grep', { pluginId, pattern, path });
      },
    },
    'workspace.snapshot': {
      permission: 'filesystem:workspace',
      invoke: (params) =>
        invoke('pluginRuntime:workspace.snapshot', {
          pluginId,
          path: (params as { path: string }).path,
        }),
    },
    'workspace.symbols': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { paths, digests } = params as { paths: string[]; digests?: Record<string, string> };
        return invoke('pluginRuntime:workspace.symbols', { pluginId, paths, digests });
      },
    },
    'artifact.read': {
      permission: 'artifact:read',
      invoke: () => invoke('pluginRuntime:artifact.read', { pluginId }),
    },
  };
}
