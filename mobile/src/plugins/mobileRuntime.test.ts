import { describe, expect, it } from 'vitest';
import { buildMobileRuntimeHtml, type MobileCodePlugin } from './mobileRuntime';

const plugin: MobileCodePlugin = {
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
});
