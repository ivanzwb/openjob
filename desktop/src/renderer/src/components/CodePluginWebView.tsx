import { useEffect, useRef } from 'react';
import type { LlmRole } from '@core/enums';
import { invoke, onEvent } from '../ipc';
import { getUiAssets, onPluginEvent } from '../codePlugins/runtime';

/**
 * 代码插件的 Webview 沙箱页面（§7.9）。
 *
 * iframe `sandbox="allow-scripts"`：插件 UI 拿不到宿主 DOM 与 cookie，与宿主的
 * 全部通信走受控桥——页面内 postMessage 一个 `{ openjob: { reqId, method, params } }`，
 * 宿主按白名单方法代为调用 IPC 并回 `{ openjobResponse: { reqId, ... } }`；
 * 宿主事件以 `{ openjobEvent: ... }` 单向推入。越权方法由主进程门面再校验一道。
 * 资源切片：html 与内联脚本都来自签名信封里的 ui/ 资产（slice 1 只支持内联资源）。
 */

const BASE_BRIDGE_METHODS = {
  'storage.get': (pluginId: string, params: { key: string }) =>
    invoke('codePlugin:storage.get', { pluginId, key: params.key }),
  'storage.set': (pluginId: string, params: { key: string; value: string }) =>
    invoke('codePlugin:storage.set', { pluginId, key: params.key, value: params.value }),
  'storage.delete': (pluginId: string, params: { key: string }) =>
    invoke('codePlugin:storage.delete', { pluginId, key: params.key }),
  'campaign.getDescriptor': (_pluginId: string, params: { campaignId: string }) =>
    invoke('campaign:getRuntimeDescriptor', { campaignId: params.campaignId }),
};

/** 权限 → 额外桥方法。repo:* 通道在宿主侧还有权限网关逐次校验 */
function bridgeMethods(permissions: readonly string[]) {
  const methods: Record<string, (pluginId: string, params: never) => Promise<unknown>> = {
    ...BASE_BRIDGE_METHODS,
  };
  if (permissions.includes('repository:read')) {
    methods['repo.list'] = (pluginId) => invoke('repo:list', undefined).then((r) => {
      void pluginId;
      return r;
    });
    methods['repo.gitStatus'] = (pluginId) => invoke('repo:gitStatus', undefined).then((r) => {
      void pluginId;
      return r;
    });
    methods['repo.add'] = (_pluginId, params: { url: string }) =>
      invoke('repo:add', { url: params.url });
    methods['repo.update'] = (_pluginId, params: { id: string }) =>
      invoke('repo:update', { id: params.id });
    methods['repo.delete'] = (_pluginId, params: { id: string }) =>
      invoke('repo:delete', { id: params.id });
  }
  if (permissions.includes('evidence:read-confirmed')) {
    methods['evidence.listConfirmed'] = (_pluginId, params: { campaignId: string }) =>
      invoke('codePlugin:evidence.listConfirmed', { pluginId: _pluginId, campaignId: params.campaignId });
  }
  if (permissions.includes('llm:complete')) {
    // 基础流式问答：llm:chat 开流，增量经 stream:* 事件推入沙箱
    methods['agent.ask'] = (
      _pluginId,
      params: {
        question: string;
        role?: LlmRole;
        allowTools?: boolean;
        repoId?: string;
        campaignId?: string;
      },
    ) =>
      invoke('llm:chat', {
        role: params.role ?? 'codeAgent',
        messages: [{ role: 'user', content: params.question }],
        allowTools: params.allowTools ?? false,
        allowWebSearch: false,
        ...(params.repoId !== undefined ? { repoId: params.repoId } : {}),
        ...(params.campaignId !== undefined ? { campaignId: params.campaignId } : {}),
      });
  }
  return methods;
}

export function CodePluginWebView({
  pluginId,
  webviewPath,
  permissions,
}: {
  pluginId: string;
  webviewPath: string;
  permissions: readonly string[];
}): React.JSX.Element | null {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const assets = getUiAssets(pluginId);
  const html = assets[webviewPath];
  const methods = bridgeMethods(permissions);

  // 宿主事件单向推入沙箱：页面据此刷新，不需要自己实现轮询
  useEffect(() => {
    const forward = (event: string) => (payload: unknown) => {
      frameRef.current?.contentWindow?.postMessage(
        { openjobEvent: { event, ...(payload as Record<string, unknown>) } },
        '*',
      );
    };
    const offAttached = onPluginEvent('campaign:attached', forward('campaign:attached'));
    const offCapability = onPluginEvent('campaign:capability-changed', forward('campaign:capability-changed'));
    // 流式问答增量（stream:*）同属宿主事件，按 streamId 由页面自行过滤
    const offDelta = onEvent('stream:delta', forward('stream:delta'));
    const offDone = onEvent('stream:done', forward('stream:done'));
    const offError = onEvent('stream:error', forward('stream:error'));
    return () => {
      offAttached();
      offCapability();
      offDelta();
      offDone();
      offError();
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as
        | { openjob?: { reqId: number; method: string; params: Record<string, unknown> } }
        | undefined;
      if (!data?.openjob) return;
      const { reqId, method, params } = data.openjob;
      void (async () => {
        let result: unknown = null;
        let error: string | null = null;
        try {
          if (method in methods) {
            result = await methods[method as keyof typeof methods](
              pluginId,
              params as never,
            );
          } else {
            throw new Error(`未开放的桥方法：${method}`);
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        frameRef.current?.contentWindow?.postMessage(
          { openjobResponse: { reqId, result, error } },
          '*',
        );
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pluginId]);

  if (html === undefined) {
    return (
      <p className="p-4 text-sm text-[var(--color-muted)]">
        缺少 Webview 资源：{webviewPath}
      </p>
    );
  }

  return (
    <iframe
      ref={frameRef}
      sandbox="allow-scripts"
      title={pluginId}
      className="h-full w-full border-0"
      srcDoc={html}
    />
  );
}
