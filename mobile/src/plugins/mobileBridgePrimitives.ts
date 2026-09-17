/**
 * 移动端放行的**通用桥原语表**（分发计划 §11.2 桥自注册 / §7 手机端降级）。
 *
 * 与桌面那张表同构，但**桌面才有的原语刻意不在这里**（`workspace.*`、`artifact.read`、
 * `agent.ask` 等）——手机端没有这些能力，包声明了也如实拒绝（`unavailable`），
 * 不假装能执行。传输用一个注入的 `call`，这样这张表本身是纯数据、可单测。
 */
import type { PluginBridgePrimitives } from '@core/plugins/pluginRuntime/bridge';

/** 桌面有、手机端没有的桥方法；声明了也拒绝，供用例与诊断引用。 */
export const MOBILE_UNAVAILABLE_METHODS: readonly string[] = [
  'workspace.read',
  'workspace.write',
  'workspace.delete',
  'workspace.list',
  'workspace.glob',
  'workspace.grep',
  'workspace.snapshot',
  'workspace.symbols',
  'artifact.read',
  'agent.ask',
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
    'campaign.getDescriptor': {
      invoke: (params) =>
        call('campaign:getRuntimeDescriptor', {
          campaignId: text((params as { campaignId?: unknown }).campaignId),
        }),
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
