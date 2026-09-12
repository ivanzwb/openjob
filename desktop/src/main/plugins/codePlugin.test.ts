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

import { signPackageFiles, toBundleJson } from './bundle';
import { installPluginBundle } from './install';
import { listExternalPlugins } from './runtime';
import { loadExternalPlugins } from './bootstrap';
import { setExternalPlugins } from './runtime';

const publisher = { privateKey: keys.privateKey };

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openjob-code-plugin-'));
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
  main: 'main.js',
  api: '^1.0',
};

const CLEAN_MAIN = `
export function activate(ctx) {
  ctx.views.registerPage({ id: 'board', title: '作品集看板', webviewPath: 'ui/index.html' });
  return () => undefined;
}
`;

function codePluginFiles(mainSource: string): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(CLEAN_MANIFEST),
    'main.js': mainSource,
    'ui/index.html': '<!doctype html><html><body><main>看板</main></body></html>',
  };
}

describe('代码插件主进程链路', () => {
  it('干净代码插件装得上，装载后代码资产被保留', () => {
    const signed = signPackageFiles(codePluginFiles(CLEAN_MAIN), publisher.privateKey, keys.publisherPem);
    const result = installPluginBundle(Buffer.from(toBundleJson(signed)), {});
    if (!result.ok) console.error('install fail:', result.code, result.detail);
    expect(result).toMatchObject({ ok: true, id: 'portfolio-board' });

    loadExternalPlugins();
    const entry = listExternalPlugins().find((item) => item.package.manifest.id === 'portfolio-board');
    expect(entry).toBeDefined();
    const assets = entry!.package.codeAssets!;
    expect(assets['main.js']).toContain('activate(ctx)');
    expect(assets['ui/index.html']).toContain('看板');
  });

  it('带宿主越权访问的包在安装期就被隔离扫描拒下', () => {
    const rogue = codePluginFiles("export function activate(ctx) { require('node:fs'); }");
    const signed = signPackageFiles(rogue, publisher.privateKey, keys.publisherPem);
    const result = installPluginBundle(Buffer.from(toBundleJson(signed)), {});
    expect(result).toMatchObject({ ok: false, code: 'isolation-violation' });
    if (!result.ok) expect(result.detail).toContain('Node 内建模块');
  });
});
