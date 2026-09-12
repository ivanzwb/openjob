import { useEffect, useRef } from 'react';
import { invoke } from '../ipc';
import { getUiAssets } from '../codePlugins/runtime';

/**
 * 代码插件的 Webview 沙箱页面（§7.9）。
 *
 * iframe `sandbox="allow-scripts"`：插件 UI 拿不到宿主 DOM 与 cookie，与宿主的
 * 全部通信走受控桥——页面内 postMessage 一个 `{ openjob: { reqId, method, params } }`，
 * 宿主按白名单方法代为调用 IPC 并回 `{ openjobResponse: { reqId, ... } }`。
 * 资源切片：html 与内联脚本都来自签名信封里的 ui/ 资产（slice 1 只支持内联资源）。
 */

const BRIDGE_METHODS = {
  'storage.get': (pluginId: string, params: { key: string }) =>
    invoke('codePlugin:storage.get', { pluginId, key: params.key }),
  'storage.set': (pluginId: string, params: { key: string; value: string }) =>
    invoke('codePlugin:storage.set', { pluginId, key: params.key, value: params.value }),
  'storage.delete': (pluginId: string, params: { key: string }) =>
    invoke('codePlugin:storage.delete', { pluginId, key: params.key }),
} as const;

export function CodePluginWebView({
  pluginId,
  webviewPath,
}: {
  pluginId: string;
  webviewPath: string;
}): React.JSX.Element | null {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const assets = getUiAssets(pluginId);
  const html = assets[webviewPath];

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
          if (method === 'campaign.getDescriptor') {
            result = await invoke('campaign:getRuntimeDescriptor', {
              campaignId: String(params.campaignId ?? ''),
            });
          } else if (method in BRIDGE_METHODS) {
            result = await BRIDGE_METHODS[method as keyof typeof BRIDGE_METHODS](
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
