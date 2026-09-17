import { useEffect, useRef } from 'react';
import { resolveWebviewHtml } from '@core/plugins/pluginRuntime/assets';
import {
  createPluginBridge,
  declaredPermissionBridgeGate,
} from '@core/plugins/pluginRuntime/bridge';
import { onEvent } from '../ipc';
import { getUiAssets, onPluginEvent } from '../pluginRuntimes/runtime';
import { desktopBridgePrimitives } from '../pluginRuntimes/bridgePrimitives';

/**
 * 代码插件的 Webview 沙箱页面（§7.9）。
 *
 * iframe `sandbox="allow-scripts"`：插件 UI 拿不到宿主 DOM 与 cookie，与宿主的
 * 全部通信走受控桥——页面内 postMessage 一个 `{ openjob: { reqId, method, params } }`，
 * 宿主按白名单方法代为调用 IPC 并回 `{ openjobResponse: { reqId, ... } }`；
 * 宿主事件以 `{ openjobEvent: ... }` 单向推入。越权方法由主进程门面再校验一道。
 * 资源切片：html 与相对引用的 ui/ 资产（js/css）都来自签名信封，经解析内联。
 *
 * 桥方法只有**一个来源**：包自己声明的（§11.2 桥自注册），实现在
 * `pluginRuntimes/bridgePrimitives.ts` 的通用原语表里，放行由权限网关判。这里不再有
 * 「按权限整段放行」的硬编码表——那正是岗位簇方法曾经进宿主 UI 的通道，也是「未声明
 * 即够不到」名不副实的原因。
 */

export function PluginRuntimeWebView({
  pluginId,
  webviewPath,
  permissions,
  declaredBridgeMethods,
}: {
  pluginId: string;
  webviewPath: string;
  permissions: readonly string[];
  /** 包在入口代码里声明的桥方法（§11.2 桥自注册）：未声明的页面够不到 */
  declaredBridgeMethods: readonly string[];
}): React.JSX.Element | null {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const assets = getUiAssets(pluginId);
  const html = assets[webviewPath]
    ? resolveWebviewHtml(webviewPath, assets[webviewPath], assets)
    : undefined;
  // 桥方法 = 包声明 ∩ 本端通用原语表（§11.2 桥自注册）：声明了哪些就放行哪些，未声明
  // 的页面够不到。声明只决定「能不能到网关」，放行与否交给权限网关（端侧判一次，
  // 主进程网关权威判一次）；声明了但原语表里没有的方法不进 methods。
  const methods: Record<string, (pluginId: string, params: never) => Promise<unknown>> = {};
  const declaredBridge = createPluginBridge({
    pluginId,
    declared: declaredBridgeMethods,
    primitives: desktopBridgePrimitives(pluginId),
    gate: declaredPermissionBridgeGate(permissions),
  });
  for (const method of declaredBridge.methods) {
    methods[method] = (_pluginId: string, params: never) => declaredBridge.call(method, params);
  }

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
    const offPractice = onEvent('practice:completed', forward('practice:completed'));
    return () => {
      offAttached();
      offCapability();
      offDelta();
      offDone();
      offError();
      offPractice();
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
