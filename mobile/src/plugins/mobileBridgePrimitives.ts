/**
 * 移动端放行的**通用桥原语表**（分发计划 §11.2 桥自注册 / §7 手机端降级）。
 *
 * 与桌面那张表同构，但**写侧刻意不在表里**：手机端不装载插件包、也没有宿主工作区实现，
 * 写 / 删 / 快照 / 远端拉取、artifact 读入，以及往话术库里写，声明了也如实拒绝
 * （`unavailable`），不假装能执行。
 *
 * 读侧可以代理到已配对的桌面端（`invokeRemote`）：工作区的读 / 遍历 / glob / grep / 符号
 * 与基础问答都由桌面按包声明的权限执行——桌面按 pluginId 解析出**本包工作区**，读到的
 * 就是桌面那份检出，范围与桌面自己的渲染层完全一致。话术库同理只放读侧。
 * 传输用一个注入的 `call`，这样这张表本身是纯数据、可单测。
 */
import type { PluginBridgePrimitives } from '@core/plugins/pluginRuntime/bridge';

/** 桌面有、手机端没有（或只给读）的桥方法；声明了也拒绝，供用例与诊断引用。 */
export const MOBILE_UNAVAILABLE_METHODS: readonly string[] = [
  // 工作区写侧只在桌面有：手机端不落盘、不删、不拉取，也不套一份快照
  'workspace.write',
  'workspace.delete',
  'workspace.snapshot',
  'workspace.fetch',
  'artifact.read',
  // 手机端对包数据只读：读走配对桌面，写如实拒绝，不假装能落盘
  'data.put',
  'data.delete',
  // 话术库同理：读侧（listSnippets）放行，写侧落进同步库的动作留给桌面
  'library.saveSnippet',
];

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** `call` 把一条受控通道转发到已配对的桌面端（`invokeRemote`），并解出 result。 */
export function mobileBridgePrimitives(
  call: (channel: string, payload?: unknown) => Promise<unknown>,
): PluginBridgePrimitives {
  return {
    'storage.get': {
      invoke: (params) => call('pluginRuntime:storage.get', { key: text((params as { key?: unknown }).key) }),
    },
    'storage.set': {
      invoke: (params) => {
        const { key, value } = params as { key?: unknown; value?: unknown };
        return call('pluginRuntime:storage.set', { key: text(key), value: text(value) });
      },
    },
    'storage.delete': {
      invoke: (params) => call('pluginRuntime:storage.delete', { key: text((params as { key?: unknown }).key) }),
    },
    // 包声明的数据集合（阶段 3 B2）：手机端只读，读走配对桌面的受控通道（本地插件作用域）；
    // 写（data.put / data.delete）在 MOBILE_UNAVAILABLE_METHODS 里如实拒绝。
    'data.get': {
      invoke: (params) => {
        const { collection, key } = params as { collection?: unknown; key?: unknown };
        return call('pluginRuntime:data.get', { collection: text(collection), key: text(key) });
      },
    },
    'data.list': {
      invoke: (params) => {
        const { collection, prefix, limit } = params as {
          collection?: unknown;
          prefix?: unknown;
          limit?: unknown;
        };
        return call('pluginRuntime:data.list', {
          collection: text(collection),
          prefix: prefix === undefined ? undefined : text(prefix),
          limit,
        });
      },
    },
    'data.count': {
      invoke: (params) =>
        call('pluginRuntime:data.count', {
          collection: text((params as { collection?: unknown }).collection),
        }),
    },
    // 工作区读侧（§11.2）：代理到配对桌面端的本包工作区——桌面按包声明的
    // filesystem:workspace 解析根目录，路径约束与上限判定全在桌面，手机端只传相对路径。
    'workspace.read': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { path, startLine, endLine } = params as {
          path?: unknown;
          startLine?: unknown;
          endLine?: unknown;
        };
        return call('pluginRuntime:workspace.read', { path: text(path), startLine, endLine });
      },
    },
    'workspace.list': {
      permission: 'filesystem:workspace',
      invoke: (params) =>
        call('pluginRuntime:workspace.list', {
          path: text((params as { path?: unknown }).path ?? '.'),
        }),
    },
    'workspace.glob': {
      permission: 'filesystem:workspace',
      invoke: (params) =>
        call('pluginRuntime:workspace.glob', {
          pattern: text((params as { pattern?: unknown }).pattern),
        }),
    },
    'workspace.grep': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { pattern, path } = params as { pattern?: unknown; path?: unknown };
        return call('pluginRuntime:workspace.grep', {
          pattern: text(pattern),
          path: path === undefined ? undefined : text(path),
        });
      },
    },
    'workspace.symbols': {
      permission: 'filesystem:workspace',
      invoke: (params) => {
        const { paths, digests } = params as { paths?: unknown; digests?: unknown };
        return call('pluginRuntime:workspace.symbols', { paths, digests });
      },
    },
    'campaign.getDescriptor': {
      invoke: (params) =>
        call('campaign:getRuntimeDescriptor', {
          campaignId: text((params as { campaignId?: unknown }).campaignId),
        }),
    },
    // 基础流式问答（§7.9）：编排与工具在宿主，领域上下文由包自己拼。被问的是配对桌面的
    // 工作区，回答经宿主事件流推回页面（见 PluginRuntimesScreen 的 openjobEvent 转发）。
    'agent.ask': {
      permission: 'llm:complete',
      invoke: (params) => {
        const { question, role, allowTools, campaignId } = params as {
          question?: unknown;
          role?: unknown;
          allowTools?: unknown;
          campaignId?: unknown;
        };
        return call('llm:chat', {
          ...(role !== undefined ? { role: text(role) } : {}),
          messages: [{ role: 'user', content: text(question) }],
          allowTools: allowTools ?? false,
          allowWebSearch: false,
          ...(campaignId !== undefined ? { campaignId: text(campaignId) } : {}),
        });
      },
    },
    // 话术库读侧：取回包自己这一类来源存过的话术（写侧由桌面承担，如实拒绝）
    'library.listSnippets': {
      permission: 'library:write',
      invoke: (params) => {
        const { sourceKind, limit } = params as { sourceKind?: unknown; limit?: unknown };
        return call('pluginRuntime:library.listSnippets', {
          sourceKind: sourceKind === undefined ? undefined : text(sourceKind),
          limit,
        });
      },
    },
    'evidence.listConfirmed': {
      permission: 'evidence:read-confirmed',
      invoke: (params) =>
        call('evidence:listConfirmed', {
          campaignId: text((params as { campaignId?: unknown }).campaignId),
        }),
    },
  };
}
