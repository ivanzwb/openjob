import { useCallback, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import type { SQLiteDatabase } from 'expo-sqlite';
import { buildMobileRuntimeHtml, type MobileCodePlugin } from '../plugins/mobileRuntime';
import { listMobileCodePlugins } from '../data/codePluginLocal';
import { invokeRemote } from '../remote/rpc';
import { getRawDb } from '../db';
import { useTheme } from '../theme';

/**
 * 代码插件的移动端运行时屏（§12.5）。
 *
 * 列出本机缓存里带代码资产的岗位包；点开后用 WebView 运行时激活入口——
 * 同一份 main.js 与 ui 资产，桥走 invokeRemote 转发桌面白名单通道
 * （storage / campaign / repo / evidence），桌面权限网关逐次校验。
 * 功能可降级：桥调用失败把错误文本直接渲染在页面里，不静默吞。
 */

type BridgeReply = {
  openjob?: { reqId: number; method: string; params: Record<string, unknown> };
};

/** 移动端桥白名单：与桌面受控桥同构，远端权限网关再校验一道 */
function bridgeMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'storage.get':
      return invokeRemote('codePlugin:storage.get', { key: String(params.key ?? '') }).then(
        (r) => r.result,
      );
    case 'storage.set':
      return invokeRemote('codePlugin:storage.set', {
        key: String(params.key ?? ''),
        value: String(params.value ?? ''),
      }).then(() => undefined);
    case 'storage.delete':
      return invokeRemote('codePlugin:storage.delete', { key: String(params.key ?? '') }).then(
        () => undefined,
      );
    case 'campaign.getDescriptor':
      return invokeRemote('campaign:getRuntimeDescriptor', {
        campaignId: String(params.campaignId ?? ''),
      }).then((r) => r.result);
    case 'repo.list':
      return invokeRemote('repo:list').then((r) => r.result);
    case 'repo.add':
      return invokeRemote('repo:add', { url: String(params.url ?? '') }).then((r) => r.result);
    case 'repo.update':
      return invokeRemote('repo:update', { id: String(params.id ?? '') }).then((r) => r.result);
    case 'evidence.listConfirmed':
      return invokeRemote('evidence:listConfirmed', {
        campaignId: String(params.campaignId ?? ''),
      }).then((r) => r.result);
    default:
      return Promise.reject(new Error(`未开放的桥方法：${method}`));
  }
}

function PluginRuntimeView({ plugin }: { plugin: MobileCodePlugin }): React.JSX.Element {
  const theme = useTheme();
  const webRef = useRef<WebView>(null);

  const html = buildMobileRuntimeHtml(plugin);

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let parsed: BridgeReply | null = null;
      try {
        parsed = JSON.parse(event.nativeEvent.data) as BridgeReply;
      } catch {
        return;
      }
      const openjob = parsed?.openjob;
      if (!openjob) return;
      const { reqId, method, params } = openjob;
      void bridgeMethod(method, params ?? {}).then(
        (result) => {
          const reply = JSON.stringify({ __openjobReply: { reqId, result, error: null } });
          webRef.current?.injectJavaScript(`window.__openjobReply(${reply}); true;`);
        },
        (cause: unknown) => {
          const reply = JSON.stringify({
            __openjobReply: {
              reqId,
              result: null,
              error: cause instanceof Error ? cause.message : String(cause),
            },
          });
          webRef.current?.injectJavaScript(`window.__openjobReply(${reply}); true;`);
        },
      );
    },
    [],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <WebView
        ref={webRef}
        source={{ html }}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled={false}
      />
    </View>
  );
}

export function CodePluginsScreen(): React.JSX.Element {
  const theme = useTheme();
  const [plugins, setPlugins] = useState<MobileCodePlugin[] | null>(null);
  const [selected, setSelected] = useState<MobileCodePlugin | null>(null);

  useFocusEffect(
    useCallback(() => {
      setPlugins(listMobileCodePlugins(getRawDb()));
    }, []),
  );

  if (selected) {
    return <PluginRuntimeView plugin={selected} />;
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 8, backgroundColor: theme.bg }}>
      <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 4 }}>
        已随岗位包启用的代码插件。功能与本机能力对齐：不支持的调用会显式报错。
      </Text>
      {(plugins ?? []).map((plugin) => (
        <Pressable
          key={`${plugin.pluginId}@${plugin.version}`}
          onPress={() => setSelected(plugin)}
          style={{
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surface,
            padding: 12,
          }}
        >
          <Text style={{ color: theme.text, fontWeight: '600' }}>{plugin.displayName}</Text>
          <Text style={{ color: theme.muted, fontSize: 11 }}>
            {plugin.pluginId}@{plugin.version} · {plugin.permissions.join('、')}
          </Text>
        </Pressable>
      ))}
      {plugins !== null && plugins.length === 0 && (
        <Text style={{ color: theme.muted, fontSize: 12 }}>还没有随岗位包启用的代码插件。</Text>
      )}
    </View>
  );
}
