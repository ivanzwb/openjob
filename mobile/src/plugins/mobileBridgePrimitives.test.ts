/**
 * 移动端桥原语表（分发计划 §11.2 桥自注册 / §7 手机端降级）。
 *
 * 手机端是 view-only：桌面才有的原语（workspace / artifact / agent）不在表里，
 * 包声明了也如实拒绝（`unavailable`），不假装能执行。
 */
import { describe, expect, it, vi } from 'vitest';
import { createPluginBridge, type PluginBridgeGate } from '@core/plugins/pluginRuntime/bridge';
import { MOBILE_UNAVAILABLE_METHODS, mobileBridgePrimitives } from './mobileBridgePrimitives';

// 标注类型：不标的话 `{ allowed: true }` 会被推成 `{ allowed: boolean }`，与网关的判别联合对不上
const allowAll: PluginBridgeGate = { authorize: () => ({ allowed: true }) };

describe('移动端桥原语表', () => {
  it('只收本端有的通用原语；桌面才有的能力不在表里', () => {
    const primitives = mobileBridgePrimitives(async () => undefined);
    expect(Object.keys(primitives).sort()).toEqual([
      'campaign.getDescriptor',
      'data.count',
      'data.get',
      'data.list',
      'evidence.listConfirmed',
      'storage.delete',
      'storage.get',
      'storage.set',
    ]);
    for (const method of MOBILE_UNAVAILABLE_METHODS) {
      expect(primitives[method], method).toBeUndefined();
    }
  });

  it('转发到已配对桌面端的受控通道', async () => {
    const call = vi.fn(async () => 'ok');
    const primitives = mobileBridgePrimitives(call);
    await primitives['storage.get']!.invoke({ key: 'notes' });
    expect(call).toHaveBeenCalledWith('pluginRuntime:storage.get', { key: 'notes' });

    await primitives['data.get']!.invoke({ collection: 'repositories', key: 'r1' });
    expect(call).toHaveBeenCalledWith('pluginRuntime:data.get', {
      collection: 'repositories',
      key: 'r1',
    });
    await primitives['data.count']!.invoke({ collection: 'repositories' });
    expect(call).toHaveBeenCalledWith('pluginRuntime:data.count', {
      collection: 'repositories',
    });
  });
});

describe('手机端按声明放行，桌面的能力如实拒绝', () => {
  it('声明了 workspace.read → unavailable（本端没有这个桥能力）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['storage.get', 'workspace.read'],
      primitives: mobileBridgePrimitives(async () => null),
      gate: allowAll,
    });
    expect(bridge.methods).toEqual(['storage.get']);
    await expect(bridge.call('workspace.read', {})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('声明了 data.put → unavailable（手机端对包数据只读）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['data.get', 'data.put', 'data.delete'],
      primitives: mobileBridgePrimitives(async () => null),
      gate: allowAll,
    });
    expect(bridge.methods).toEqual(['data.get']);
    await expect(bridge.call('data.put', { collection: 'repositories' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(bridge.call('data.delete', { collection: 'repositories' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('未声明一律拒（默认拒绝）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['storage.get'],
      primitives: mobileBridgePrimitives(async () => null),
      gate: allowAll,
    });
    await expect(bridge.call('evidence.listConfirmed', { campaignId: 'c' })).rejects.toMatchObject({
      code: 'not-declared',
    });
  });
});
