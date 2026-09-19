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
import type { ExplanationTier } from '@core/enums';
import type { PluginBridgePrimitives } from '@core/plugins/pluginRuntime/bridge';
import { invoke } from '../ipc';

export function desktopBridgePrimitives(
  pluginId: string,
  version: string,
): PluginBridgePrimitives {
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
    // 包声明的数据集合（阶段 3 B2）：与 storage.* 一样没有权限门槛，是否放行由包自己的
    // manifest 声明决定（主进程按声明判，未声明的集合拒）。
    'data.get': {
      invoke: (params) => {
        const { collection, key } = params as { collection: string; key: string };
        return invoke('pluginRuntime:data.get', { pluginId, collection, key });
      },
    },
    'data.put': {
      invoke: (params) => {
        const { collection, key, value } = params as {
          collection: string;
          key: string;
          value: string;
        };
        return invoke('pluginRuntime:data.put', { pluginId, collection, key, value });
      },
    },
    'data.delete': {
      invoke: (params) => {
        const { collection, key } = params as { collection: string; key: string };
        return invoke('pluginRuntime:data.delete', { pluginId, collection, key });
      },
    },
    'data.list': {
      invoke: (params) => {
        const { collection, prefix, limit } = params as {
          collection: string;
          prefix?: string;
          limit?: number;
        };
        return invoke('pluginRuntime:data.list', { pluginId, collection, prefix, limit });
      },
    },
    'data.count': {
      invoke: (params) => {
        const { collection } = params as { collection: string };
        return invoke('pluginRuntime:data.count', { pluginId, collection });
      },
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
    // 拉取比其它工作区原语多一项声明：网络出口（network:fetch）与落盘（filesystem:workspace）
    // 是两种能力，宿主侧两项都要过；桥这边按「区分性更强的那一项」申报
    'workspace.fetch': {
      permission: 'network:fetch',
      invoke: (params) => {
        const { url, dir } = params as { url: string; dir?: string };
        return invoke('pluginRuntime:workspace.fetch', { pluginId, url, dir });
      },
    },
    'artifact.read': {
      permission: 'artifact:read',
      invoke: () => invoke('pluginRuntime:artifact.read', { pluginId }),
    },
    // 话术库原语（§11.2 通用原语）：把页面里的一段文字存进**用户的话术库**。来源类型
    // （sourceKind）与来源标签由包自己给，宿主不理解——这条原语没有岗位语义。
    'library.saveSnippet': {
      permission: 'library:write',
      invoke: (params) => {
        const { text, sourceKind, sourceLabel, tier } = params as {
          text: string;
          sourceKind: string;
          sourceLabel: string;
          tier?: ExplanationTier;
        };
        return invoke('pluginRuntime:library.saveSnippet', {
          pluginId,
          text,
          sourceKind,
          sourceLabel,
          ...(tier !== undefined ? { tier } : {}),
        });
      },
    },
    'library.listSnippets': {
      permission: 'library:write',
      invoke: (params) => {
        const { sourceKind, limit } = params as { sourceKind?: string; limit?: number };
        return invoke('pluginRuntime:library.listSnippets', { pluginId, sourceKind, limit });
      },
    },
    // 标记原语（同一份 library:write 授权）：包把自己的标记写进宿主的**跨功能标记汇总**。
    // targetKind（自由字符串）与 targetLabel 都由包给，宿主不认识；kind / selectedText /
    // note / color 逐项对应到通道字段。
    'library.annotate': {
      permission: 'library:write',
      invoke: (params) => {
        const { targetKind, targetId, targetLabel, kind, selectedText, note, color } = params as {
          targetKind: string;
          targetId: string;
          targetLabel?: string;
          kind: string;
          selectedText?: string;
          note?: string;
          color?: string;
        };
        return invoke('pluginRuntime:library.annotate', {
          pluginId,
          targetKind,
          targetId,
          kind,
          ...(targetLabel !== undefined ? { targetLabel } : {}),
          ...(selectedText !== undefined ? { selectedText } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(color !== undefined ? { color } : {}),
        });
      },
    },
    'library.listAnnotations': {
      permission: 'library:write',
      invoke: (params) => {
        const { targetKind, limit } = params as { targetKind?: string; limit?: number };
        return invoke('pluginRuntime:library.listAnnotations', { pluginId, targetKind, limit });
      },
    },
    'library.deleteAnnotation': {
      permission: 'library:write',
      invoke: (params) =>
        invoke('pluginRuntime:library.deleteAnnotation', {
          pluginId,
          id: (params as { id: string }).id,
        }),
    },
    // 受控 LLM 补全（§11.2 通用原语）：System / User 文本由包自己带，宿主只负责端点、
    // 审计与 JSON 解析。提示词正文是包自己的内容，宿主不认识任何岗位簇的题型。
    'llm.complete': {
      permission: 'llm:complete',
      invoke: (params) => {
        const { system, user, role } = params as {
          system: string;
          user: string;
          role?: string;
        };
        return invoke('pluginRuntime:llm.complete', {
          pluginId,
          version,
          system,
          user,
          ...(role !== undefined ? { role } : {}),
        });
      },
    },
    // 基础流式问答（§7.9）：编排与工具在宿主，**领域上下文由包自己拼**——这里刻意没有
    // 「指定哪个仓库」这类岗位参数，包要问源码就自己用工作区原语取出片段再问。
    'agent.ask': {
      permission: 'llm:complete',
      invoke: (params) => {
        const { question, role, allowTools, campaignId } = params as {
          question: string;
          role?: string;
          allowTools?: boolean;
          campaignId?: string;
        };
        return invoke('llm:chat', {
          ...(role !== undefined ? { role } : {}),
          messages: [{ role: 'user', content: question }],
          allowTools: allowTools ?? false,
          allowWebSearch: false,
          ...(campaignId !== undefined ? { campaignId } : {}),
        });
      },
    },
    // 已确认证据只读（§13.4）：新证据只能经 proposal 通道
    'evidence.listConfirmed': {
      permission: 'evidence:read-confirmed',
      invoke: (params) =>
        invoke('pluginRuntime:evidence.listConfirmed', {
          pluginId,
          campaignId: (params as { campaignId: string }).campaignId,
        }),
    },
  };
}
