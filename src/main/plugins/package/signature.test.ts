/**
 * 签名与完整性校验。
 *
 * 用当场生成的密钥对，不依赖任何仓库内密钥：测的是算法接得对不对，
 * 而不是某把具体钥匙。
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  PACKAGE_SIGNATURE_FILE,
  type PluginPackageFiles,
} from '@shared/plugins/package/contract';
import { classifyPackageTrust, packageDigest } from './signature';

function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

const CONTENT: PluginPackageFiles = {
  [PACKAGE_MANIFEST_FILE]: '{"id":"demo","version":"1.0.0"}',
  [PACKAGE_PACK_FILE]: '{"competencyTemplates":[]}',
};

function signPackage(
  files: PluginPackageFiles,
  key: ReturnType<typeof newKeyPair>,
): PluginPackageFiles {
  const signature = sign(null, Buffer.from(packageDigest(files), 'utf8'), key.privateKey);
  return {
    ...files,
    [PACKAGE_SIGNATURE_FILE]: JSON.stringify({
      publicKey: key.publicKeyPem,
      signature: signature.toString('base64'),
    }),
  };
}

describe('packageDigest', () => {
  it('与文件枚举顺序无关', () => {
    const reordered = Object.fromEntries(Object.entries(CONTENT).reverse());

    expect(packageDigest(reordered)).toBe(packageDigest(CONTENT));
  });

  it('内容变一个字节摘要就变', () => {
    const tweaked = { ...CONTENT, [PACKAGE_PACK_FILE]: '{"competencyTemplates":[] }' };

    expect(packageDigest(tweaked)).not.toBe(packageDigest(CONTENT));
  });

  it('把内容整体换个文件名也算变化', () => {
    // 摘要只覆盖内容的话，pack.json ↔ contributions.json 这类结构篡改看不出来
    const renamed = {
      [PACKAGE_MANIFEST_FILE]: CONTENT[PACKAGE_MANIFEST_FILE]!,
      'contributions.json': CONTENT[PACKAGE_PACK_FILE]!,
    };

    expect(packageDigest(renamed)).not.toBe(packageDigest(CONTENT));
  });

  it('签名文件本身不参与摘要', () => {
    const key = newKeyPair();

    expect(packageDigest(signPackage(CONTENT, key))).toBe(packageDigest(CONTENT));
  });
});

describe('classifyPackageTrust', () => {
  it('发布密钥签的包判为第一方', () => {
    const key = newKeyPair();

    expect(classifyPackageTrust(signPackage(CONTENT, key), [key.publicKeyPem])).toBe('first-party');
  });

  it('PEM 的空白差异不影响是不是同一把钥匙', () => {
    const key = newKeyPair();
    const padded = `\n${key.publicKeyPem.trim()}\n\n`;

    expect(classifyPackageTrust(signPackage(CONTENT, key), [padded])).toBe('first-party');
  });

  it('别人签的包内容完好，判为来源未知', () => {
    const theirs = newKeyPair();
    const ours = newKeyPair();

    expect(classifyPackageTrust(signPackage(CONTENT, theirs), [ours.publicKeyPem])).toBe(
      'unknown-signer',
    );
  });

  it('签完再改内容一律判为篡改，绝不退化成来源未知', () => {
    const key = newKeyPair();
    const signed = signPackage(CONTENT, key);
    const tampered = { ...signed, [PACKAGE_PACK_FILE]: '{"competencyTemplates":["injected"]}' };

    // 这是签名文件必须内嵌公钥的原因：判成 unknown-signer 的话，用户点一下
    // 「仍然信任」就把改过的第一方包装进去了
    for (const trusted of [[key.publicKeyPem], []]) {
      expect(classifyPackageTrust(tampered, trusted)).toBe('tampered');
    }
  });

  it('删掉一个文件也算篡改', () => {
    const key = newKeyPair();
    const { [PACKAGE_PACK_FILE]: _dropped, ...rest } = signPackage(CONTENT, key);

    expect(classifyPackageTrust(rest, [key.publicKeyPem])).toBe('tampered');
  });

  it('没有签名文件判为未签名', () => {
    expect(classifyPackageTrust(CONTENT, [])).toBe('unsigned');
    expect(classifyPackageTrust({ ...CONTENT, [PACKAGE_SIGNATURE_FILE]: '  ' }, [])).toBe(
      'unsigned',
    );
  });

  it('签名文件本身坏掉时判为篡改，而不是抛异常', () => {
    const key = newKeyPair();
    const broken = [
      'not json',
      '{}',
      JSON.stringify({ publicKey: key.publicKeyPem }),
      JSON.stringify({ publicKey: 'not a key', signature: 'AAAA' }),
      JSON.stringify({ publicKey: key.publicKeyPem, signature: 'not base64!!' }),
    ];

    for (const raw of broken) {
      expect(classifyPackageTrust({ ...CONTENT, [PACKAGE_SIGNATURE_FILE]: raw }, []), raw).toBe(
        'tampered',
      );
    }
  });

  it('RSA 之类的非 Ed25519 公钥不被接受', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const raw = JSON.stringify({
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      signature: Buffer.alloc(64).toString('base64'),
    });

    expect(classifyPackageTrust({ ...CONTENT, [PACKAGE_SIGNATURE_FILE]: raw }, [])).toBe(
      'tampered',
    );
  });
});
