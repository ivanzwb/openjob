import { describe, expect, it } from 'vitest';
import { resolveWebviewHtml } from './assets';

const assets: Record<string, string> = {
  'ui/index.html': '<p>x</p>',
  'ui/app.js': 'console.log("app");',
  'ui/style.css': 'body { color: red; }',
  'ui/lib/vendor.js': 'window.__vendor = true;',
};

describe('resolveWebviewHtml', () => {
  it('同目录 script src 内联为脚本内容', () => {
    const html = '<html><head></head><body><script src="app.js"></script></body></html>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets);
    expect(resolved).toContain('console.log');
    expect(resolved).not.toContain('src=');
  });

  it('子目录与 ./ 前缀都能解析', () => {
    const html = '<script src="./lib/vendor.js"></script>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets);
    expect(resolved).toContain('__vendor');
  });

  it('stylesheet link 内联为 style 标签', () => {
    const html = '<link rel="stylesheet" href="style.css">';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets);
    expect(resolved).toContain('<style>body');
    expect(resolved).not.toContain('href=');
  });

  it('外部 URL 与无法解析的引用原样保留', () => {
    const html = '<script src="https://cdn.example/x.js"></script><script src="missing.js"></script>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets);
    expect(resolved).toContain('https://cdn.example/x.js');
    expect(resolved).toContain('missing.js');
  });

  it('.. 越出 ui/ 顶层视为不可解析，原样保留', () => {
    const html = '<script src="../../evil.js"></script>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets);
    expect(resolved).toBe(html);
  });
});
