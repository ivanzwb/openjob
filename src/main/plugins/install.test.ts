/**
 * 安装与卸载。
 *
 * 用真实临时 userData：这一层的价值是「盘上最终留下了什么」，mock 掉文件系统就没了。
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = { userData: '', pluginsDir: '' };

vi.mock('../paths', () => ({
  getAppPaths: () => paths,
}));

import { BUILT_IN_CAPABILITY_PLUGINS } from '@shared/plugins/builtin';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  type PluginPackageFiles,
} from '@shared/plugins/package/contract';
import type { RolePack } from '@shared/plugins/types';
import { signPackageFiles, toBundleJson } from './bundle';
import { installPluginBundle, parseBundle, uninstallPlugin } from './install';
import { setExternalPlugins } from './runtime';

const publisher = generateKeyPairSync('ed25519');
const PUBLISHER_PEM = publisher.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const stranger = generateKeyPairSync('ed25519');
const STRANGER_PEM = stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** 装成第一方发布密钥。trustedKeys 从 resources/plugin-keys.json 读，测试里直接铺一份。 */
function writeTrustedKey(): void {
  const resources = join(process.cwd(), 'resources');
  writeFileSync(join(resources, 'plugin-keys.json'), JSON.stringify({ keys: [PUBLISHER_PEM] }));
}

let keyFileExisted = false;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'openjob-install-'));
  paths.userData = root;
  paths.pluginsDir = join(root, 'plugins');
  keyFileExisted = existsSync(join(process.cwd(), 'resources', 'plugin-keys.json'));
  writeTrustedKey();
});

afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true });
  if (!keyFileExisted) {
    rmSync(join(process.cwd(), 'resources', 'plugin-keys.json'), { force: true });
  }
  setExternalPlugins([]);
});

function rolePackFiles(id = 'demo.role', version = '2.0.0'): PluginPackageFiles {
  const source = structuredClone(DISTRIBUTED_ROLE_PACKS[0]!) as RolePack;
  const { manifest, ...rest } = source;
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify({ ...manifest, id, version, dependencies: [] }),
    [PACKAGE_PACK_FILE]: JSON.stringify(rest),
  };
}

function bundle(
  files: PluginPackageFiles = rolePackFiles(),
  signer = publisher,
  signerPem = PUBLISHER_PEM,
): Buffer {
  return Buffer.from(toBundleJson(signPackageFiles(files, signer.privateKey, signerPem)), 'utf8');
}

function installedDirs(): string[] {
  return existsSync(paths.pluginsDir) ? readdirSync(paths.pluginsDir).sort() : [];
}

describe('parseBundle', () => {
  it('接受纯 JSON 与 gzip 两种形态，结果相同', () => {
    const raw = bundle();
    const plain = parseBundle(raw);
    const zipped = parseBundle(gzipSync(raw));

    expect(plain.ok && zipped.ok).toBe(true);
    if (!plain.ok || !zipped.ok) return;
    expect(zipped.files).toEqual(plain.files);
  });

  it('信封里出现白名单外的文件名就拒，路径穿越无从谈起', () => {
    // 不引 zip 解析器的理由就在这：条目名在这一步被限死成四个常量之一
    for (const name of ['../../evil.json', 'plugin.mjs', 'nested/manifest.json']) {
      const raw = Buffer.from(JSON.stringify({ files: { [name]: '{}' } }), 'utf8');
      const parsed = parseBundle(raw);

      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) expect(parsed.detail).toContain(name);
    }
  });

  it('缺 files、不是 JSON、内容不是字符串都拒', () => {
    for (const raw of ['{}', 'not json', '{"files":[]}', '{"files":{"manifest.json":123}}']) {
      expect(parseBundle(Buffer.from(raw, 'utf8')).ok, raw).toBe(false);
    }
  });

  it('gzip 炸弹被解压上限挡住，而不是吃光内存', () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20));

    const parsed = parseBundle(bomb);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toContain('解压失败');
  });
});

describe('installPluginBundle', () => {
  it('第一方签名的包装到 <id>@<version> 目录，并立即可用', () => {
    const result = installPluginBundle(bundle());

    expect(result).toMatchObject({ ok: true, id: 'demo.role', version: '2.0.0', trust: 'first-party' });
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('装完之后暂存目录不留在 plugins/ 下', () => {
    installPluginBundle(bundle());

    // 暂存目录若留在 plugins/ 里，下次扫描会把它自己报成一个坏包
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('陌生签名者默认拒装，显式确认后放行', () => {
    const raw = bundle(rolePackFiles(), stranger, STRANGER_PEM);

    expect(installPluginBundle(raw)).toMatchObject({ code: 'untrusted-signer' });
    expect(installedDirs()).toEqual([]);

    expect(installPluginBundle(raw, { trustUnknownSigner: true })).toMatchObject({
      ok: true,
      trust: 'unknown-signer',
    });
  });

  it('签完再改内容一律拒装，确认信任也不放行', () => {
    const signed = signPackageFiles(rolePackFiles(), publisher.privateKey, PUBLISHER_PEM);
    const tampered = Buffer.from(
      toBundleJson({ ...signed, [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}' }),
      'utf8',
    );

    for (const options of [{}, { trustUnknownSigner: true }]) {
      expect(installPluginBundle(tampered, options)).toMatchObject({ code: 'tampered' });
    }
    expect(installedDirs()).toEqual([]);
  });

  it('没签名的包拒装', () => {
    const raw = Buffer.from(toBundleJson(rolePackFiles()), 'utf8');

    expect(installPluginBundle(raw)).toMatchObject({ code: 'unsigned' });
  });

  it('格式不合法的包拒装，且不在盘上留痕', () => {
    const files = rolePackFiles();
    const broken = { ...files, [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}' };

    expect(installPluginBundle(bundle(broken))).toMatchObject({ code: 'invalid-package' });
    expect(installedDirs()).toEqual([]);
  });

  it('与内置能力插件同 id@version 的包拒装', () => {
    const builtIn = BUILT_IN_CAPABILITY_PLUGINS[0]!.manifest;
    const files = rolePackFiles(builtIn.id, builtIn.version);

    expect(installPluginBundle(bundle(files))).toMatchObject({ code: 'reserved-id' });
  });

  it('官方岗位包的 id@version 不被内置清单占用', () => {
    const pack = DISTRIBUTED_ROLE_PACKS[0]!.manifest;
    const files = rolePackFiles(pack.id, pack.version);

    expect(installPluginBundle(bundle(files))).toMatchObject({ ok: true });
  });

  it('重复安装默认拒绝，overwrite 才覆盖', () => {
    installPluginBundle(bundle());

    expect(installPluginBundle(bundle())).toMatchObject({ code: 'already-installed' });
    expect(installPluginBundle(bundle(), { overwrite: true })).toMatchObject({ ok: true });
    expect(installedDirs()).toEqual(['demo.role@2.0.0']);
  });

  it('同 id 的不同版本可以并存', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.1.0')));

    expect(installedDirs()).toEqual(['demo.role@2.0.0', 'demo.role@2.1.0']);
  });
});

describe('uninstallPlugin', () => {
  it('删掉目录并报告删过', () => {
    installPluginBundle(bundle());

    expect(uninstallPlugin('demo.role', '2.0.0')).toEqual({ removed: true });
    expect(installedDirs()).toEqual([]);
  });

  it('没装过也算成功，调用方不必先查', () => {
    expect(uninstallPlugin('never.installed', '1.0.0')).toEqual({ removed: false });
  });

  it('重复卸载幂等', () => {
    installPluginBundle(bundle());
    uninstallPlugin('demo.role', '2.0.0');

    expect(uninstallPlugin('demo.role', '2.0.0')).toEqual({ removed: false });
  });

  it('只删指定版本，不动同 id 的其它版本', () => {
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.0.0')));
    installPluginBundle(bundle(rolePackFiles('demo.role', '2.1.0')));

    uninstallPlugin('demo.role', '2.0.0');

    expect(installedDirs()).toEqual(['demo.role@2.1.0']);
  });
});
