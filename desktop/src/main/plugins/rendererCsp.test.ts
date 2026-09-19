/**
 * 渲染层 CSP 必须放行插件运行时依赖的两条 script 来源。
 *
 * 包入口是在渲染层用 `new Function` 求值的，包页面则是以 srcdoc 内联进
 * `sandbox="allow-scripts"` 的 iframe（页面自己的脚本是内联脚本，继承本策略）。
 * CSP 里少了 `unsafe-eval` 或 `unsafe-inline`，这两步就会被浏览器拦下——而现象是
 * 「激活失败」只在开发者工具里留一行，用户侧只看到「装上了、面板也在、页面一个都不出」。
 * 这种沉默的失败值得一条关卡：收紧 CSP 的人必须同时处理插件运行时的入口求值方式。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX_HTML = join(__dirname, '..', '..', 'renderer', 'index.html');

function rendererCsp(): string {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
  if (!match) throw new Error('渲染层 index.html 里找不到 CSP');
  return match[1]!;
}

describe('渲染层 CSP 与插件运行时', () => {
  it('放行包入口求值与包页面内联脚本', () => {
    const csp = rendererCsp();
    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));
    expect(scriptSrc, 'CSP 里必须有 script-src').toBeDefined();
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'unsafe-inline'");
  });
});
