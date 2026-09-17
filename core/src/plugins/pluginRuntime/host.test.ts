import { describe, expect, it, vi } from 'vitest';
import type { CampaignRuntimeDescriptor } from '../types';
import {
  activatePluginRuntime,
  pluginRuntimeNamespaces,
  createEventHub,
  type PluginRuntimeModule,
  type PluginRuntimeServices,
} from './host';

function services(): PluginRuntimeServices {
  return {
    campaign: { getDescriptor: async () => null as CampaignRuntimeDescriptor | null },
    storage: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
  };
}

describe('activatePluginRuntime', () => {
  it('注册的页面带插件命名空间， deactivate 后全部撤干净', () => {
    const hub = createEventHub();
    const handler = vi.fn();
    const plugin: PluginRuntimeModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'board', title: '看板', webviewPath: 'ui/index.html' });
        ctx.commands.register('refresh', () => undefined);
        ctx.events.on('campaign:attached', handler);
        return () => ctx.commands.register('aftermath', () => undefined);
      },
    };

    const active = activatePluginRuntime({
      pluginId: 'portfolio',
      version: '1.0.0',
      module: plugin,
      services: services(),
      hub,
    });

    expect(active.pages).toEqual([
      {
        pluginId: 'portfolio',
        fullId: 'portfolio:board',
        id: 'board',
        title: '看板',
        webviewPath: 'ui/index.html',
      },
    ]);
    expect(active.commands).toEqual(['portfolio:refresh']);

    hub.emit('campaign:attached', { campaignId: 'c1' });
    expect(handler).toHaveBeenCalledTimes(1);

    active.deactivate();
    hub.emit('campaign:attached', { campaignId: 'c1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(active.pages).toEqual([]);
    expect(active.commands).toEqual([]);
    // deactivate 幂等
    expect(() => active.deactivate()).not.toThrow();
  });

  it('命名空间与路径规则', () => {
    const hub = createEventHub();
    const plugin: PluginRuntimeModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: '大写', title: 'x', webviewPath: 'ui/index.html' });
      },
    };
    expect(() =>
      activatePluginRuntime({ pluginId: 'p', version: '1.0.0', module: plugin, services: services(), hub }),
    ).toThrow('视图 id 不合法');

    const badPath: PluginRuntimeModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'ok', title: 'x', webviewPath: '../secret.html' });
      },
    };
    expect(() =>
      activatePluginRuntime({ pluginId: 'p', version: '1.0.0', module: badPath, services: services(), hub }),
    ).toThrow('webview 路径必须在 ui/ 下');
  });

  it('重复注册与未开放事件都被拒', () => {
    const hub = createEventHub();
    const duplicate: PluginRuntimeModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'a', title: 'x', webviewPath: 'ui/a.html' });
        ctx.views.registerPage({ id: 'a', title: 'y', webviewPath: 'ui/b.html' });
      },
    };
    expect(() =>
      activatePluginRuntime({ pluginId: 'p', version: '1.0.0', module: duplicate, services: services(), hub }),
    ).toThrow('视图重复注册');

    const rogue: PluginRuntimeModule = {
      activate(ctx) {
        // @ts-expect-error 故意订阅未开放的事件
        ctx.events.on('node:fs', () => undefined);
      },
    };
    expect(() =>
      activatePluginRuntime({ pluginId: 'p', version: '1.0.0', module: rogue, services: services(), hub }),
    ).toThrow('未开放的事件');
  });

  it('activate 抛错则整个插件不处于激活态', () => {
    const hub = createEventHub();
    const boom: PluginRuntimeModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'a', title: 'x', webviewPath: 'ui/a.html' });
        throw new Error('初始化失败');
      },
    };
    expect(() =>
      activatePluginRuntime({ pluginId: 'p', version: '1.0.0', module: boom, services: services(), hub }),
    ).toThrow('初始化失败');
  });
});

describe('pluginRuntimeNamespaces', () => {
  it('基础命名空间人人可见，llm/evidence 只对声明权限的插件开放', () => {
    const base = pluginRuntimeNamespaces([]);
    expect(base).toContain('views');
    expect(base).toContain('storage');
    // bridge 与基础命名空间同级：声明桥方法没有权限门槛
    expect(base).toContain('bridge');
    expect(base).not.toContain('artifact');
    expect(base).not.toContain('workspace');
    expect(base).not.toContain('llm');
    expect(base).not.toContain('evidence');

    const full = pluginRuntimeNamespaces(['llm:complete', 'evidence:read-confirmed']);
    expect(full).toContain('llm');
    expect(full).toContain('evidence');
  });

  it('artifact 原语只对声明 artifact:read 的插件注入', () => {
    expect(pluginRuntimeNamespaces([])).not.toContain('artifact');
    expect(pluginRuntimeNamespaces(['artifact:read'])).toContain('artifact');
  });

  it('ctx 透传 campaign/llm/evidence/artifact 服务与 bridge 命名空间', async () => {
    const hub = createEventHub();
    let seen = false;
    const plugin: PluginRuntimeModule = {
      activate(ctx) {
        seen =
          typeof ctx.llm?.complete === 'function' &&
          typeof ctx.evidence?.listConfirmed === 'function' &&
          typeof ctx.artifact?.read === 'function' &&
          typeof ctx.bridge.declare === 'function';
      },
    };
    activatePluginRuntime({
      pluginId: 'p',
      version: '1.0.0',
      module: plugin,
      services: {
        campaign: { getDescriptor: async () => null },
        storage: { get: async () => null, set: async () => undefined, delete: async () => undefined },
        llm: { complete: async () => ({}) },
        evidence: { listConfirmed: async () => [] },
        artifact: {
          read: async () => ({
            name: 'a.csv',
            format: 'delimited',
            text: 'a,b',
            bytes: 3,
            sha256: '0'.repeat(64),
            rows: [['a', 'b']],
          }),
        },
      },
      hub,
    });
    expect(seen).toBe(true);
  });
});
