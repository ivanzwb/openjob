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

  it('给了页面 id 就渲染那一页，没给就回落第一页', () => {
    // 「更多」里的「源码」入口带着包声明的页面 id 进来，运行时按 <pluginId>:<pageId> 定位
    const targeted = buildMobileRuntimeHtml(plugin, 'board');
    expect(targeted).toContain('var targetPage = "board";');
    expect(targeted).toContain("pages[i].id === pluginId + ':' + targetPage");

    // 没带 id（列表进来）或 id 对不上（包改过页面）时都落在第一页，不会白屏
    expect(buildMobileRuntimeHtml(plugin)).toContain('var targetPage = "";');
    expect(targeted).toContain('renderPage(wanted || pages[0])');
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
