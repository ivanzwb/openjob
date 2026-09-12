import { describe, expect, it, vi } from 'vitest';
import type { CampaignRuntimeDescriptor } from '../types';
import {
  activateCodePlugin,
  createEventHub,
  type CodePluginModule,
  type CodePluginServices,
} from './host';

function services(): CodePluginServices {
  return {
    campaign: { getDescriptor: async () => null as CampaignRuntimeDescriptor | null },
    storage: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
  };
}

describe('activateCodePlugin', () => {
  it('注册的页面带插件命名空间， deactivate 后全部撤干净', () => {
    const hub = createEventHub();
    const handler = vi.fn();
    const plugin: CodePluginModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'board', title: '看板', webviewPath: 'ui/index.html' });
        ctx.commands.register('refresh', () => undefined);
        ctx.events.on('campaign:attached', handler);
        return () => ctx.commands.register('aftermath', () => undefined);
      },
    };

    const active = activateCodePlugin({
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
    const plugin: CodePluginModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: '大写', title: 'x', webviewPath: 'ui/index.html' });
      },
    };
    expect(() =>
      activateCodePlugin({ pluginId: 'p', version: '1.0.0', module: plugin, services: services(), hub }),
    ).toThrow('视图 id 不合法');

    const badPath: CodePluginModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'ok', title: 'x', webviewPath: '../secret.html' });
      },
    };
    expect(() =>
      activateCodePlugin({ pluginId: 'p', version: '1.0.0', module: badPath, services: services(), hub }),
    ).toThrow('webview 路径必须在 ui/ 下');
  });

  it('重复注册与未开放事件都被拒', () => {
    const hub = createEventHub();
    const duplicate: CodePluginModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'a', title: 'x', webviewPath: 'ui/a.html' });
        ctx.views.registerPage({ id: 'a', title: 'y', webviewPath: 'ui/b.html' });
      },
    };
    expect(() =>
      activateCodePlugin({ pluginId: 'p', version: '1.0.0', module: duplicate, services: services(), hub }),
    ).toThrow('视图重复注册');

    const rogue: CodePluginModule = {
      activate(ctx) {
        // @ts-expect-error 故意订阅未开放的事件
        ctx.events.on('node:fs', () => undefined);
      },
    };
    expect(() =>
      activateCodePlugin({ pluginId: 'p', version: '1.0.0', module: rogue, services: services(), hub }),
    ).toThrow('未开放的事件');
  });

  it('activate 抛错则整个插件不处于激活态', () => {
    const hub = createEventHub();
    const boom: CodePluginModule = {
      activate(ctx) {
        ctx.views.registerPage({ id: 'a', title: 'x', webviewPath: 'ui/a.html' });
        throw new Error('初始化失败');
      },
    };
    expect(() =>
      activateCodePlugin({ pluginId: 'p', version: '1.0.0', module: boom, services: services(), hub }),
    ).toThrow('初始化失败');
  });
});
