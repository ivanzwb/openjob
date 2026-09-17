import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import {
  createPluginBridge,
  declaredPermissionBridgeGate,
} from '@core/plugins/pluginRuntime/bridge';
import { buildMobileRuntimeHtml, type MobilePluginRuntime } from '../plugins/mobileRuntime';
import { mobileBridgePrimitives } from '../plugins/mobileBridgePrimitives';
import { listMobilePluginRuntimes } from '../data/pluginRuntimeLocal';
import { invokeRemote } from '../remote/rpc';
import { getRawDb } from '../db';
import { useTheme } from '../theme';

/**
 * 代码插件的移动端运行时屏（§12.5）。
 *
 * 列出本机缓存里带移动端实现的岗位包；点开后用 WebView 运行时激活入口——
 * 岗位包的 mobile/ 那份 main.js 与 ui 资产，桥走 invokeRemote 转发桌面白名单通道
 * （storage / campaign / repo / evidence），桌面权限网关逐次校验。
 * 功能可降级：桥调用失败把错误文本直接渲染在页面里，不静默吞。
 */

type BridgeReply = {
  openjob?: { reqId: number; method: string; params: Record<string, unknown> };
  /** WebView shim 回传的桥方法声明（§11.2 桥自注册） */
  openjobDeclarations?: string[];
  /** 入口 activate 抛错时的文案（不吞，显式让界面看到） */
  openjobActivationError?: string;
};

/**
 * 移动端桥白名单里**岗位簇方法**的过渡路径（阶段 2 随搬迁下线）。
 *
 * 通用原语（storage / campaign / evidence）已改走桥自注册（`createPluginBridge`），
 * 这里只剩待搬迁的岗位簇方法——渲染层不再为它们单开机制。
 * 远端权限网关仍逐次校验，移动端只是传输层。
 */
function bridgeMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'storage.get':
      return invokeRemote('pluginRuntime:storage.get', { key: String(params.key ?? '') }).then(
        (r) => r.result,
      );
    case 'storage.set':
      return invokeRemote('pluginRuntime:storage.set', {
        key: String(params.key ?? ''),
        value: String(params.value ?? ''),
      }).then(() => undefined);
    case 'storage.delete':
      return invokeRemote('pluginRuntime:storage.delete', { key: String(params.key ?? '') }).then(
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

function PluginRuntimeView({ plugin }: { plugin: MobilePluginRuntime }): React.JSX.Element {
  const theme = useTheme();
  const webRef = useRef<WebView>(null);
  const [declared, setDeclared] = useState<readonly string[]>([]);

  const html = buildMobileRuntimeHtml(plugin);

  // 桥自注册（§11.2）：包在入口代码里声明要用的桥方法，宿主按声明放行。手机端
  // 原语表里没有桌面才有的能力（workspace / artifact / agent），声明了也如实拒绝。
  const declaredBridge = useMemo(
    () =>
      createPluginBridge({
        pluginId: plugin.pluginId,
        declared,
        primitives: mobileBridgePrimitives((channel, payload) =>
          invokeRemote(channel, payload).then((r) => r.result),
        ),
        gate: declaredPermissionBridgeGate(plugin.permissions),
      }),
    [plugin.pluginId, plugin.permissions, declared],
  );

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let parsed: BridgeReply | null = null;
      try {
        parsed = JSON.parse(event.nativeEvent.data) as BridgeReply;
      } catch {
        return;
      }
      // shim 激活入口后回传声明：记下来，后续调用按声明放行
      if (parsed?.openjobDeclarations) {
        setDeclared(parsed.openjobDeclarations);
        return;
      }
      const openjob = parsed?.openjob;
      if (!openjob) return;
      const { reqId, method, params } = openjob;
      const run = (): Promise<unknown> => {
        // 声明过的走桥自注册：未声明 / 本端没有 / 网关拒绝都在这里如实报错
        if (declaredBridge.declared.includes(method)) {
          return declaredBridge.call(method, params ?? {});
        }
        // 未声明的岗位簇方法暂由 legacy 表兜着，阶段 2 随搬迁下线
        return bridgeMethod(method, params ?? {});
      };
      void run().then(
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
    [declaredBridge],
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

export function PluginRuntimesScreen(): React.JSX.Element {
  const theme = useTheme();
  const [plugins, setPlugins] = useState<MobilePluginRuntime[] | null>(null);
  const [selected, setSelected] = useState<MobilePluginRuntime | null>(null);

  useFocusEffect(
    useCallback(() => {
      setPlugins(listMobilePluginRuntimes(getRawDb()));
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
