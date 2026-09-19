/**
 * 移动端桥原语表（分发计划 §11.2 桥自注册 / §7 手机端降级）。
 *
 * 手机端几乎只能读：工作区的读侧、基础问答与标记读侧代理到已配对的桌面端（桌面按
 * pluginId 解析本包工作区）；工作区写 / artifact / 数据写入 / 标记写入不在表里，包声明了
 * 也如实拒绝（`unavailable`）。唯一的写侧例外是话术库：片段落进同步的话术库、随同步回到
 * 桌面，所以 saveSnippet 放行。
 */
import { describe, expect, it, vi } from 'vitest';
import { createPluginBridge, type PluginBridgeGate } from '@core/plugins/pluginRuntime/bridge';
import { MOBILE_UNAVAILABLE_METHODS, mobileBridgePrimitives } from './mobileBridgePrimitives';

// 标注类型：不标的话 `{ allowed: true }` 会被推成 `{ allowed: boolean }`，与网关的判别联合对不上
const allowAll: PluginBridgeGate = { authorize: () => ({ allowed: true }) };

describe('移动端桥原语表', () => {
  it('收下读侧通用原语；写侧与桌面专属能力不在表里', () => {
    const primitives = mobileBridgePrimitives(async () => undefined);
    expect(Object.keys(primitives).sort()).toEqual([
      'agent.ask',
      'campaign.getDescriptor',
      'data.count',
      'data.get',
      'data.list',
      'evidence.listConfirmed',
      'library.listAnnotations',
      'library.listSnippets',
      'library.saveSnippet',
      'storage.delete',
      'storage.get',
      'storage.set',
      'workspace.glob',
      'workspace.grep',
      'workspace.list',
      'workspace.read',
      'workspace.symbols',
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

    // 工作区读侧与话术库读侧同样只转发，路径约束与权限判定都在桌面
    await primitives['workspace.read']!.invoke({ path: 'repo/src/index.ts', startLine: 1, endLine: 40 });
    expect(call).toHaveBeenCalledWith('pluginRuntime:workspace.read', {
      path: 'repo/src/index.ts',
      startLine: 1,
      endLine: 40,
    });
    await primitives['library.listSnippets']!.invoke({ sourceKind: 'code-ref', limit: 20 });
    expect(call).toHaveBeenCalledWith('pluginRuntime:library.listSnippets', {
      sourceKind: 'code-ref',
      limit: 20,
    });
    // 话术库的写侧手机端也放行：片段落进同步的话术库，随同步回到桌面
    await primitives['library.saveSnippet']!.invoke({
      text: 'const x = 1',
      sourceKind: 'code-ref',
      sourceLabel: 'src/a.ts:3',
    });
    expect(call).toHaveBeenCalledWith('pluginRuntime:library.saveSnippet', {
      text: 'const x = 1',
      sourceKind: 'code-ref',
      sourceLabel: 'src/a.ts:3',
    });
    await primitives['library.listAnnotations']!.invoke({ targetKind: 'code-mark', limit: 50 });
    expect(call).toHaveBeenCalledWith('pluginRuntime:library.listAnnotations', {
      targetKind: 'code-mark',
      limit: 50,
    });
  });
});

describe('手机端按声明放行，写侧与桌面专属能力如实拒绝', () => {
  it('声明了 workspace.write → unavailable（本端没有写能力）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['storage.get', 'workspace.write'],
      primitives: mobileBridgePrimitives(async () => null),
      gate: allowAll,
    });
    expect(bridge.methods).toEqual(['storage.get']);
    await expect(bridge.call('workspace.write', {})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('声明了 workspace.read / agent.ask → 放行（读侧代理到配对桌面）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['workspace.read', 'agent.ask'],
      primitives: mobileBridgePrimitives(async () => null),
      gate: allowAll,
    });
    expect(bridge.methods).toEqual(['agent.ask', 'workspace.read']);
  });

  it('声明了 data.put / library.annotate → unavailable（手机端对数据与标记只读）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['data.get', 'data.put', 'data.delete', 'library.annotate', 'library.deleteAnnotation'],
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
    await expect(
      bridge.call('library.annotate', { targetKind: 'code-mark', targetId: 'a:1', kind: 'note' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bridge.call('library.deleteAnnotation', { id: 'a1' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('声明了 library.saveSnippet → 放行（片段落进同步的话术库）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'ap.pack',
      declared: ['library.saveSnippet', 'library.listSnippets', 'library.listAnnotations'],
      primitives: mobileBridgePrimitives(async () => null),
      gate: allowAll,
    });
    expect(bridge.methods).toEqual([
      'library.listAnnotations',
      'library.listSnippets',
      'library.saveSnippet',
    ]);
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
