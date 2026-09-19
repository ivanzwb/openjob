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

  it('没有主题时不注入任何样式', () => {
    const html = '<html><head></head><body>x</body></html>';
    expect(resolveWebviewHtml('ui/index.html', html, assets)).toBe(html);
  });

  it('主题变量注入成 :root 规则', () => {
    const html = '<html><head><style>body{color:red}</style></head><body>x</body></html>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets, {
      '--color-surface': '#f6f7f9',
      '--color-accent': '#2f5cd8',
    });
    expect(resolved).toContain('<style data-openjob-theme>:root{--color-surface:#f6f7f9;--color-accent:#2f5cd8}</style>');
  });

  it('注入样式排在页面自己的样式之前，页面规则仍然覆盖它', () => {
    const html = '<html><head><style>body{color:red}</style></head><body>x</body></html>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets, { '--color-fg': '#000' });
    expect(resolved.indexOf('data-openjob-theme')).toBeLessThan(resolved.indexOf('body{color:red}'));
  });

  it('没有 <head> 时仍插在页面样式之前', () => {
    const html = '<html><body><style>body{color:red}</style></body></html>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets, { '--color-fg': '#000' });
    expect(resolved.indexOf('data-openjob-theme')).toBeLessThan(resolved.indexOf('body{color:red}'));
  });

  it('注入样式落在 <meta charset> 之后、页面样式之前', () => {
    const html =
      '<html><head><meta charset="utf-8" /><style>body{color:red}</style></head><body>x</body></html>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets, { '--color-fg': '#000' });
    expect(resolved.indexOf('charset')).toBeLessThan(resolved.indexOf('data-openjob-theme'));
    expect(resolved.indexOf('data-openjob-theme')).toBeLessThan(resolved.indexOf('body{color:red}'));
  });

  it('值里带 } 或 ; 的变量被丢弃，不能逃出规则', () => {
    const html = '<html><head></head><body>x</body></html>';
    const resolved = resolveWebviewHtml('ui/index.html', html, assets, {
      '--ok': '#000',
      '--evil': '}body{display:none}',
      '--also-bad': 'red;color:blue',
      'not-a-var': 'x',
      '--<x>': '1',
    });
    expect(resolved).toContain('--ok:#000');
    expect(resolved).not.toContain('display:none');
    expect(resolved).not.toContain('also-bad');
    expect(resolved).not.toContain('not-a-var');
  });
});
