/**
 * 代码插件（§7.9）主进程链路验收：签名信封安装 → 装载保留代码资产 →
 * 隔离扫描拒下违规包。渲染层的激活与 Webview 桥不在这里（无 DOM 环境）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as nodeCrypto from 'node:crypto';

const keys = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require('node:crypto') as typeof nodeCrypto;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publisherPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
});

vi.mock('./package/trustedKeys', () => ({
  loadTrustedPublicKeys: () => [keys.publisherPem],
}));

const paths = { userData: '', pluginsDir: '' };
vi.mock('../paths', () => ({ getAppPaths: () => paths }));

import { selectPlatformAssets } from '@core/plugins/package/contract';
import { signPackageFiles, encodeBundle } from './bundle';
import { installPluginBundle } from './install';
import { listExternalPlugins } from './runtime';
import { loadExternalPlugins } from './bootstrap';
import { setExternalPlugins } from './runtime';

const publisher = { privateKey: keys.privateKey };

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openjob-plugin-runtime-'));
  paths.userData = root;
  paths.pluginsDir = join(root, 'plugins');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setExternalPlugins([]);
});

const CLEAN_MANIFEST = {
  id: 'portfolio-board',
  version: '1.0.0',
  type: 'plugin' as const,
  displayName: '作品集看板',
  description: '代码插件验收样本：看板页面 + 命令',
  compatibility: { core: '^1.0.0', schema: 23 },
  permissions: [],
  main: 'desktop/main.js',
  mobile: 'mobile/main.js',
  api: '^1.0',
};

const CLEAN_MAIN = `
export function activate(ctx) {
  ctx.views.registerPage({ id: 'board', title: '作品集看板', webviewPath: 'ui/index.html' });
  return () => undefined;
}
`;

const CLEAN_UI = '<!doctype html><html><body><main>看板</main></body></html>';

function pluginRuntimeFiles(
  mainSource: string,
  ui: { desktop: string; mobile: string } = { desktop: CLEAN_UI, mobile: CLEAN_UI },
): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(CLEAN_MANIFEST),
    'desktop/main.js': mainSource,
    'desktop/ui/index.html': ui.desktop,
    'mobile/main.js': mainSource,
    'mobile/ui/index.html': ui.mobile,
  };
}

describe('代码插件主进程链路', () => {
  it('干净代码插件装得上，装载后代码资产被保留（键带平台前缀）', () => {
    const signed = signPackageFiles(pluginRuntimeFiles(CLEAN_MAIN), publisher.privateKey, keys.publisherPem);
    const result = installPluginBundle(encodeBundle(signed), {});
    if (!result.ok) console.error('install fail:', result.code, result.detail);
    expect(result).toMatchObject({ ok: true, id: 'portfolio-board' });

    loadExternalPlugins();
    const entry = listExternalPlugins().find((item) => item.package.manifest.id === 'portfolio-board');
    expect(entry).toBeDefined();
    const assets = entry!.package.codeAssets!;
    expect(assets['desktop/main.js']).toContain('activate(ctx)');
    expect(assets['desktop/ui/index.html']).toContain('看板');
    expect(assets['mobile/main.js']).toContain('activate(ctx)');
    expect(assets['mobile/ui/index.html']).toContain('看板');
  });

  it('桌面端取到的资产键已剥掉 platform 前缀：main.js 与 ui/**', () => {
    const signed = signPackageFiles(pluginRuntimeFiles(CLEAN_MAIN), publisher.privateKey, keys.publisherPem);
    installPluginBundle(encodeBundle(signed), {});
    loadExternalPlugins();
    const assets = listExternalPlugins().find(
      (item) => item.package.manifest.id === 'portfolio-board',
    )!.package.codeAssets;

    // 与 plugin:getEntrySource 的桌面分支同一条逻辑
    const desktop = selectPlatformAssets(assets, 'desktop');
    expect(desktop).not.toBeNull();
    expect(desktop!.source).toContain('activate(ctx)');
    expect(Object.keys(desktop!.uiAssets)).toEqual(['ui/index.html']);

    // 插件源码里的 webviewPath 保持 'ui/index.html'，两端同构
    expect(desktop!.uiAssets['ui/index.html']).toContain('看板');
  });

  it('只提供桌面实现的包在移动端取不到资产（不报错、返回 null）', () => {
    const desktopOnly = {
      'manifest.json': JSON.stringify({ ...CLEAN_MANIFEST, mobile: undefined }),
      'desktop/main.js': CLEAN_MAIN,
      'desktop/ui/index.html': CLEAN_UI,
    };
    const signed = signPackageFiles(desktopOnly, publisher.privateKey, keys.publisherPem);
    const result = installPluginBundle(encodeBundle(signed), {});
    expect(result).toMatchObject({ ok: true, id: 'portfolio-board' });

    loadExternalPlugins();
    const assets = listExternalPlugins().find(
      (item) => item.package.manifest.id === 'portfolio-board',
    )!.package.codeAssets;
    expect(selectPlatformAssets(assets, 'desktop')).not.toBeNull();
    // 移动端这份不存在的实现取不到：不报错，只是那端不出现页签
    expect(selectPlatformAssets(assets, 'mobile')).toBeNull();
  });

  it('带宿主越权访问的包在安装期就被隔离扫描拒下', () => {
    const rogue = pluginRuntimeFiles("export function activate(ctx) { require('node:fs'); }");
    const signed = signPackageFiles(rogue, publisher.privateKey, keys.publisherPem);
    const result = installPluginBundle(encodeBundle(signed), {});
    expect(result).toMatchObject({ ok: false, code: 'isolation-violation' });
    if (!result.ok) expect(result.detail).toContain('Node 内建模块');
  });
});
