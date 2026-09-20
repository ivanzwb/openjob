import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import {
  createPluginBridge,
  declaredPermissionBridgeGate,
} from '@core/plugins/pluginRuntime/bridge';
import type { SyncRpcResponse } from '@core/sync';
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
 * （storage / campaign / 仓库 / evidence），桌面权限网关逐次校验。
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
    case 'evidence.listConfirmed':
      return invokeRemote('evidence:listConfirmed', {
        campaignId: String(params.campaignId ?? ''),
      }).then((r) => r.result);
    default:
      return Promise.reject(new Error(`未开放的桥方法：${method}`));
  }
}

export function PluginRuntimeView({ plugin }: { plugin: MobilePluginRuntime }): React.JSX.Element {
  const theme = useTheme();
  const webRef = useRef<WebView>(null);
  const [declared, setDeclared] = useState<readonly string[]>([]);

  const html = buildMobileRuntimeHtml(plugin);
  // 配对桌面回传的宿主事件（stream:*）：落到 state，下一次渲染后经 effect 推给页面。
  // 拉一帧的顺序保证「回复」先注入、页面拿到 streamId，再按 id 过滤增量，不会把增量丢掉。
  const [pendingEvents, setPendingEvents] = useState<SyncRpcResponse['events']>([]);

  useEffect(() => {
    if (!pendingEvents || pendingEvents.length === 0) return;
    for (const event of pendingEvents) {
      const payload = JSON.stringify({
        event: event.channel,
        ...(event.payload as Record<string, unknown>),
      });
      webRef.current?.injectJavaScript(
        `window.__openjobEvent && window.__openjobEvent(${payload}); true;`,
      );
    }
    // 不在这里清空：effect 只在事件对象换新（下一次桥调用带回事件）时重跑，清理反而多一轮渲染
  }, [pendingEvents]);

  // 桥调用的传输层：pluginRuntime:* 通道带上 pluginId（桌面按它解析本包工作区 / 数据集合，
  // 范围与桌面自己的渲染层一致），其余通道（llm:chat / campaign / evidence）原样转发。
  const bridgeCall = useCallback(
    async (channel: string, payload?: unknown): Promise<unknown> => {
      const outbound = channel.startsWith('pluginRuntime:')
        ? {
            ...((payload as Record<string, unknown> | undefined) ?? {}),
            pluginId: plugin.pluginId,
          }
        : payload;
      const { result, events } = await invokeRemote(channel, outbound);
      if (events && events.length > 0) setPendingEvents(events);
      return result;
    },
    [plugin.pluginId],
  );

  // 桥自注册（§11.2）：包在入口代码里声明要用的桥方法，宿主按声明放行。手机端原语表里
  // 只有读侧与基础问答，写侧方法声明了也如实拒绝（unavailable）。
  const declaredBridge = useMemo(
    () =>
      createPluginBridge({
        pluginId: plugin.pluginId,
        declared,
        primitives: mobileBridgePrimitives(bridgeCall),
        gate: declaredPermissionBridgeGate(plugin.permissions),
      }),
    [plugin.pluginId, plugin.permissions, declared, bridgeCall],
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

export function PluginRuntimesScreen({
  route,
}: {
  route?: { params?: { pluginId?: string } };
}): React.JSX.Element {
  const theme = useTheme();
  const [plugins, setPlugins] = useState<MobilePluginRuntime[] | null>(null);
  const [selected, setSelected] = useState<MobilePluginRuntime | null>(null);

  useFocusEffect(
    useCallback(() => {
      const list = listMobilePluginRuntimes(getRawDb());
      setPlugins(list);
      // 从「更多」里点某个包进来时直接打开它；没带参数就停在列表
      const wanted = route?.params?.pluginId;
      if (wanted) setSelected(list.find((plugin) => plugin.pluginId === wanted) ?? null);
    }, [route?.params?.pluginId]),
  );

  if (selected) {
    return <PluginRuntimeView plugin={selected} />;
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 8, backgroundColor: theme.bg }}>
      <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 4 }}>
        岗位包自带的页面（软件工程包的「源码」页就在这里）。功能与本机能力对齐：不支持的调用会显式报错。
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
        <Text style={{ color: theme.muted, fontSize: 12 }}>
          还没有同步到岗位包页面。先与桌面端同步一次。
        </Text>
      )}
    </View>
  );
}
