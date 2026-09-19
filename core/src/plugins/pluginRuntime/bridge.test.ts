/**
 * 桥自注册机制（分发计划 §11.2 / §6 判据三）的边界：按声明放行、未声明拒、
 * 本端没有的能力如实拒、声明 ≠ 权限（网关说了算）。
 *
 * 用一个**假包**声明一个**假方法**（`demo.echo`）来证明机制可用——不与任何岗位簇挂钩。
 */
import { describe, expect, it } from 'vitest';
import {
  PluginBridgeError,
  createPluginBridge,
  declaredPermissionBridgeGate,
  isPluginBridgeMethod,
  type PluginBridgeGate,
  type PluginBridgePrimitives,
} from './bridge';
import {
  activatePluginRuntime,
  createEventHub,
  type PluginRuntimeModule,
  type PluginRuntimeServices,
} from './host';

function services(): PluginRuntimeServices {
  return {
    campaign: { getDescriptor: async () => null },
    storage: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
    data: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
      count: async () => 0,
    },
  };
}

/** 假包：入口代码里声明一个假方法；再声明一个本端没有的方法。 */
function fakePackage(): PluginRuntimeModule {
  return {
    activate(ctx) {
      ctx.bridge.declare('demo.echo');
      ctx.bridge.declare('demo.missing');
      ctx.views.registerPage({ id: 'board', title: '看板', webviewPath: 'ui/index.html' });
    },
  };
}

const allowAll: PluginBridgeGate = { authorize: () => ({ allowed: true }) };
const denyAll: PluginBridgeGate = {
  authorize: () => ({ allowed: false, code: 'permission-undeclared' }),
};

describe('桥方法名规则', () => {
  it('必须是「命名空间.方法名」', () => {
    expect(isPluginBridgeMethod('demo.echo')).toBe(true);
    expect(isPluginBridgeMethod('artifact.read')).toBe(true);
    expect(isPluginBridgeMethod('echo')).toBe(false);
    expect(isPluginBridgeMethod('Demo.Echo')).toBe(false);
    expect(isPluginBridgeMethod('.echo')).toBe(false);
    expect(isPluginBridgeMethod('demo.')).toBe(false);
    expect(isPluginBridgeMethod(42)).toBe(false);
  });
});

describe('宿主记录包声明的桥方法（ctx.bridge）', () => {
  it('假包声明的假方法进 ActivePluginRuntime.bridgeMethods，deactivate 撤干净', () => {
    const active = activatePluginRuntime({
      pluginId: 'demo.pack',
      version: '1.0.0',
      module: fakePackage(),
      services: services(),
      hub: createEventHub(),
    });
    expect(active.bridgeMethods).toEqual(['demo.echo', 'demo.missing']);
    active.deactivate();
    expect(active.bridgeMethods).toEqual([]);
  });

  it('非法名与重复声明都被拒', () => {
    const invalid: PluginRuntimeModule = { activate: (ctx) => void ctx.bridge.declare('echo') };
    expect(() =>
      activatePluginRuntime({
        pluginId: 'p',
        version: '1.0.0',
        module: invalid,
        services: services(),
        hub: createEventHub(),
      }),
    ).toThrow('桥方法名');

    const duplicate: PluginRuntimeModule = {
      activate: (ctx) => {
        ctx.bridge.declare('demo.echo');
        ctx.bridge.declare('demo.echo');
      },
    };
    expect(() =>
      activatePluginRuntime({
        pluginId: 'p',
        version: '1.0.0',
        module: duplicate,
        services: services(),
        hub: createEventHub(),
      }),
    ).toThrow('桥方法重复声明');
  });
});

describe('按声明放行 / 未声明拒 / 本端没有如实拒', () => {
  const primitives: PluginBridgePrimitives = {
    'demo.echo': { invoke: (params) => ({ echoed: params }) },
    'artifact.read': { permission: 'artifact:read', invoke: () => ({ name: 'a.csv' }) },
  };
  /** 手机端形状：桌面才有的 `artifact.read` 不在表里。 */
  const mobilePrimitives: PluginBridgePrimitives = { 'demo.echo': primitives['demo.echo']! };

  it('正常路径：假包声明假方法 → 放行并调用', async () => {
    const active = activatePluginRuntime({
      pluginId: 'demo.pack',
      version: '1.0.0',
      module: fakePackage(),
      services: services(),
      hub: createEventHub(),
    });
    const bridge = createPluginBridge({
      pluginId: active.pluginId,
      declared: active.bridgeMethods,
      primitives,
      gate: allowAll,
    });
    expect(bridge.methods).toEqual(['demo.echo']);
    await expect(bridge.call('demo.echo', { hi: 1 })).resolves.toEqual({ echoed: { hi: 1 } });
  });

  it('拒绝路径：未声明的方法一律拒（默认拒绝）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'demo.pack',
      declared: ['demo.echo'],
      primitives,
      gate: allowAll,
    });
    await expect(bridge.call('artifact.read', {})).rejects.toMatchObject({ code: 'not-declared' });
    await expect(bridge.call('space.read', {})).rejects.toBeInstanceOf(PluginBridgeError);
  });

  it('拒绝路径：声明了但本端没有这个能力 → unavailable（§7 手机端降级）', async () => {
    const bridge = createPluginBridge({
      pluginId: 'demo.pack',
      declared: ['demo.echo', 'artifact.read'],
      primitives: mobilePrimitives,
      gate: allowAll,
    });
    expect(bridge.methods).toEqual(['demo.echo']);
    await expect(bridge.call('artifact.read', {})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('拒绝路径：声明 ≠ 权限，网关拒绝才是不放行的那一票', async () => {
    const bridge = createPluginBridge({
      pluginId: 'demo.pack',
      declared: ['artifact.read'],
      primitives,
      gate: denyAll,
    });
    await expect(bridge.call('artifact.read', {})).rejects.toMatchObject({ code: 'gateway-denied' });
  });

  it('拒绝路径：非法方法名拒', async () => {
    const bridge = createPluginBridge({
      pluginId: 'demo.pack',
      declared: ['demo.echo'],
      primitives,
      gate: allowAll,
    });
    await expect(bridge.call('echo', {})).rejects.toMatchObject({ code: 'invalid-method' });
  });
});

describe('declaredPermissionBridgeGate（端侧镜像网关）', () => {
  it('无权限要求的原语直接放行；声明了权限才放行对应原语', () => {
    const gate = declaredPermissionBridgeGate(['artifact:read']);
    expect(gate.authorize({ pluginId: 'p', method: 'demo.echo' })).toEqual({ allowed: true });
    expect(gate.authorize({ pluginId: 'p', method: 'artifact.read', permission: 'artifact:read' })).toEqual(
      { allowed: true },
    );
    const noPerm = declaredPermissionBridgeGate([]);
    expect(noPerm.authorize({ pluginId: 'p', method: 'artifact.read', permission: 'artifact:read' })).toEqual({
      allowed: false,
      code: 'permission-undeclared',
    });
  });
});
