import { describe, expect, it } from 'vitest';
import { buildMobileRuntimeHtml, type MobilePluginRuntime } from './mobileRuntime';

const plugin: MobilePluginRuntime = {
  pluginId: 'portfolio-board',
  version: '1.0.0',
  displayName: '作品集看板',
  permissions: ['evidence:read-confirmed'],
  uiAssets: {
    'ui/index.html': '<!doctype html><html><body>看板</body></html>',
  },
  mainSource: `
    module.exports.activate = function activate(ctx) {
      ctx.views.registerPage({ id: 'board', title: '看板', webviewPath: 'ui/index.html' });
      return function deactivate() {};
    };
  `,
};

describe('buildMobileRuntimeHtml', () => {
  it('内联入口源码与 ui 资产', () => {
    const html = buildMobileRuntimeHtml(plugin);
    expect(html).toContain('module.exports.activate = function activate(ctx)');
    expect(html).toContain('看板');
    expect(html).toContain('"portfolio-board"');
  });

  it('提供 openjob 门面与受控桥', () => {
    const html = buildMobileRuntimeHtml(plugin);
    expect(html).toContain("'openjob'");
    expect(html).toContain('__openjobReply');
    expect(html).toContain('postToRn');
  });

  it('main.js 里的 require 越权在运行时抛错（宿主 shim 只认 openjob）', () => {
    const html = buildMobileRuntimeHtml({
      ...plugin,
      mainSource: "require('node:fs');",
    });
    // shim 的 requireShim 抛错文案随源码一起内联，激活时在 WebView 里可见
    expect(html).toContain('只允许');
  });

  it('激活入口（与桌面同构）并把桥方法声明回传 RN（§11.2 桥自注册）', () => {
    const html = buildMobileRuntimeHtml({
      ...plugin,
      mainSource: "module.exports.activate = function (ctx) { ctx.bridge.declare('storage.get'); };",
    });
    // 宿主调用 activate(ctx)，不靠插件自己在模块顶层跑
    expect(html).toContain('.activate(openjob)');
    // 声明的桥方法随 openjobDeclarations 回传，宿主据此放行
    expect(html).toContain('openjobDeclarations');
    expect(html).toContain('bridge');
  });
});
