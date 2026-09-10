/**
 * 安装目录扫描。
 *
 * 用真实临时目录而不是 mock fs：这一层的价值全在「磁盘上乱七八糟的东西怎么处理」，
 * mock 掉文件系统就把被测对象一起 mock 掉了。
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_ROLE_PACKS } from '@shared/plugins/builtin';
import {
  PACKAGE_CONTRIBUTIONS_FILE,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  PACKAGE_SIGNATURE_FILE,
} from '@shared/plugins/package/contract';
import type { RolePack } from '@shared/plugins/types';
import { exactKeyOf, scanPluginInventory } from './inventory';
import { packageDigest } from './package/signature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openjob-plugins-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 把一个内置岗位包改个 id 落成外置包，得到一个必然合法的样本。 */
function externalRolePack(id: string, version = '2.0.0'): RolePack {
  const source = structuredClone(BUILT_IN_ROLE_PACKS[0]!) as RolePack;
  return { ...source, manifest: { ...source.manifest, id, version } };
}

function writePackage(
  dirName: string,
  files: Record<string, string>,
  options: { sign?: boolean } = { sign: true },
): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  if (options.sign !== false) {
    const signature = sign(null, Buffer.from(packageDigest(files), 'utf8'), privateKey);
    writeFileSync(
      join(dir, PACKAGE_SIGNATURE_FILE),
      JSON.stringify({ publicKey: PUBLIC_PEM, signature: signature.toString('base64') }),
      'utf8',
    );
  }
}

function rolePackFiles(pack: RolePack): Record<string, string> {
  const { manifest, ...rest } = pack;
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
    [PACKAGE_PACK_FILE]: JSON.stringify(rest),
  };
}

function installRolePack(id: string, version = '2.0.0', signed = true): RolePack {
  const pack = externalRolePack(id, version);
  writePackage(exactKeyOf(id, version), rolePackFiles(pack), { sign: signed });
  return pack;
}

function scan(reservedKeys?: Set<string>) {
  return scanPluginInventory({
    pluginsDir: root,
    trustedPublicKeys: [PUBLIC_PEM],
    reservedKeys,
  });
}

describe('scanPluginInventory', () => {
  it('目录不存在等于一个插件都没装，不是错误', () => {
    const inventory = scanPluginInventory({
      pluginsDir: join(root, 'nope'),
      trustedPublicKeys: [],
    });

    expect(inventory).toEqual({ entries: [], rejected: [] });
  });

  it('空目录扫出空清单', () => {
    expect(scan()).toEqual({ entries: [], rejected: [] });
  });

  it('第一方签名的岗位包装载成功，数据与写进去的一致', () => {
    const pack = installRolePack('demo.role');

    const inventory = scan();

    expect(inventory.rejected).toEqual([]);
    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0]!.trust).toBe('first-party');
    expect(inventory.entries[0]!.package.rolePack).toEqual(pack);
  });

  it('多个包按目录名稳定排序，扫描结果不看文件系统枚举顺序', () => {
    installRolePack('zeta.role');
    installRolePack('alpha.role');

    expect(scan().entries.map((entry) => entry.package.manifest.id)).toEqual([
      'alpha.role',
      'zeta.role',
    ]);
  });

  it('没签名的包不装载', () => {
    installRolePack('demo.role', '2.0.0', false);

    const inventory = scan();

    expect(inventory.entries).toEqual([]);
    expect(inventory.rejected[0]).toMatchObject({ reason: 'unsigned' });
  });

  it('签完再改内容的包判为篡改', () => {
    const pack = installRolePack('demo.role');
    writeFileSync(
      join(root, exactKeyOf('demo.role', '2.0.0'), PACKAGE_PACK_FILE),
      JSON.stringify({ ...pack, sourcePolicy: { preferredDomains: ['evil.example'] } }),
      'utf8',
    );

    expect(scan().rejected[0]).toMatchObject({ reason: 'tampered' });
  });

  it('陌生密钥签的包留给用户决定，不当成篡改', () => {
    installRolePack('demo.role');

    const inventory = scanPluginInventory({ pluginsDir: root, trustedPublicKeys: [] });

    expect(inventory.entries).toEqual([]);
    expect(inventory.rejected[0]).toMatchObject({ reason: 'untrusted-signer' });
  });

  it('目录名与 manifest 的 id@version 不一致就拒装', () => {
    const pack = externalRolePack('demo.role');
    writePackage('demo.role@9.9.9', rolePackFiles(pack));

    // 允许不一致的话，同一个包换个目录名就能装两遍，卸载也找不准该删哪个
    expect(scan().rejected[0]).toMatchObject({
      reason: 'directory-mismatch',
      dir: 'demo.role@9.9.9',
    });
  });

  it('包里夹带可执行文件时拒装，且原因报到具体文件名', () => {
    const pack = externalRolePack('demo.role');
    const files = { ...rolePackFiles(pack), 'plugin.mjs': 'process.exit(1)' };
    writePackage(exactKeyOf('demo.role', '2.0.0'), files);

    const rejection = scan().rejected[0];

    expect(rejection).toMatchObject({ reason: 'invalid-package' });
    expect(rejection!.detail).toContain('plugin.mjs');
  });

  it('包里的子目录同样被白名单挡住', () => {
    const pack = externalRolePack('demo.role');
    const dirName = exactKeyOf('demo.role', '2.0.0');
    writePackage(dirName, rolePackFiles(pack));
    mkdirSync(join(root, dirName, 'node_modules'));

    const rejection = scan().rejected[0];

    expect(rejection).toMatchObject({ reason: 'invalid-package' });
    expect(rejection!.detail).toContain('node_modules');
  });

  it('岗位包数据不合法时报格式错误，不进 entries', () => {
    const pack = externalRolePack('demo.role');
    const { manifest, ...rest } = pack;
    const broken = structuredClone(rest);
    broken.competencyTemplates[0]!.defaultWeight += 0.5;
    writePackage(exactKeyOf('demo.role', '2.0.0'), {
      [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
      [PACKAGE_PACK_FILE]: JSON.stringify(broken),
    });

    expect(scan()).toMatchObject({ entries: [], rejected: [{ reason: 'invalid-package' }] });
  });

  it('撞上内置插件的 id@version 时拒装', () => {
    const builtIn = BUILT_IN_ROLE_PACKS[0]!.manifest;
    const pack = externalRolePack(builtIn.id, builtIn.version);
    writePackage(exactKeyOf(builtIn.id, builtIn.version), rolePackFiles(pack));

    // 允许顶替的话，换一个同名同版本的包就能悄悄改掉内置岗位包的量规和提示词，
    // 而 descriptor 里的 configSnapshotHash 一个字都不变
    expect(
      scan(new Set([exactKeyOf(builtIn.id, builtIn.version)])).rejected[0],
    ).toMatchObject({ reason: 'duplicate' });
  });

  it('一个坏包不影响其它包装载', () => {
    installRolePack('good.role');
    installRolePack('bad.role', '2.0.0', false);

    const inventory = scan();

    expect(inventory.entries.map((entry) => entry.package.manifest.id)).toEqual(['good.role']);
    expect(inventory.rejected.map((item) => item.dir)).toEqual([exactKeyOf('bad.role', '2.0.0')]);
  });

  it('同 id 的不同版本可以共存', () => {
    installRolePack('demo.role', '2.0.0');
    installRolePack('demo.role', '2.1.0');

    expect(scan().entries.map((entry) => entry.package.manifest.version)).toEqual([
      '2.0.0',
      '2.1.0',
    ]);
  });

  it('能力包缺 contributions.json 时拒装', () => {
    const manifest = {
      ...externalRolePack('demo.cap').manifest,
      type: 'capability' as const,
      permissions: [],
      // Capability 的 manifest 契约要求声明双端运行能力，缺了会先被 manifest 校验拦下
      runtime: { desktop: 'full' as const, mobile: 'full' as const },
    };
    writePackage(exactKeyOf('demo.cap', '2.0.0'), {
      [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
    });

    const rejection = scan().rejected[0];

    expect(rejection).toMatchObject({ reason: 'invalid-package' });
    expect(rejection!.detail).toContain(PACKAGE_CONTRIBUTIONS_FILE);
  });
});
