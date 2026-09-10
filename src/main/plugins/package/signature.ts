/**
 * 插件包的完整性与来源校验。
 *
 * 放在主进程而不是 shared：要用 node:crypto，而 shared 会被手机端打包。
 * 算法选 Ed25519 是因为 Node 原生支持，不引任何新依赖。
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  PACKAGE_SIGNATURE_FILE,
  type PluginPackageFiles,
} from '@shared/plugins/package/contract';

export type PackageTrust =
  /** 第一方发布密钥签名通过 */
  | 'first-party'
  /** 内容完好，但签名者不在信任列表；装不装由用户显式决定（P06） */
  | 'unknown-signer'
  /** 没带签名 */
  | 'unsigned'
  /** 签名与内容对不上，或签名文件本身不合法：包被改过或损坏 */
  | 'tampered';

/**
 * 签名文件内容。
 *
 * 必须内嵌签名者公钥，否则无法区分「内容被篡改」和「换了个签名者」——两者都表现为
 * 「用已知公钥验不过」。把它们混为一谈的后果是：篡改过的第一方包会显示成第三方包，
 * 用户点一下「仍然信任」就装进去了。内嵌公钥之后，验签只回答「内容是否与这把钥匙
 * 签的时候一致」，而这把钥匙可不可信是独立的一层判断。
 */
interface PackageSignatureFile {
  /** SPKI PEM 格式的 Ed25519 公钥 */
  publicKey: string;
  /** base64 的 Ed25519 签名，覆盖 packageDigest 的输出 */
  signature: string;
}

/**
 * 包内容的规范化摘要。
 *
 * 逐文件算 sha256，再按文件名排序拼成 `name\nhash\n` 喂给外层 sha256。摘要覆盖**文件名**
 * 而不只是内容，否则把 pack.json 改名成 contributions.json 这类结构篡改发现不了。
 * 签名文件本身不参与，否则无法自指。
 */
export function packageDigest(files: PluginPackageFiles): string {
  const outer = createHash('sha256');
  for (const name of Object.keys(files)
    .filter((item) => item !== PACKAGE_SIGNATURE_FILE)
    .sort()) {
    const inner = createHash('sha256').update(files[name]!, 'utf8').digest('hex');
    outer.update(`${name}\n${inner}\n`, 'utf8');
  }
  return outer.digest('hex');
}

function parseEd25519PublicKey(pem: string): KeyObject | null {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** 按 DER 比对而不是比 PEM 字符串：换行和尾随空白不该影响是不是同一把钥匙。 */
function sameKey(left: KeyObject, right: KeyObject): boolean {
  return left
    .export({ type: 'spki', format: 'der' })
    .equals(right.export({ type: 'spki', format: 'der' }));
}

/**
 * 判定一个包的可信程度。
 *
 * `unknown-signer` 表示内容完好、只是签名者陌生，可以交给用户决定；`tampered` 表示
 * 内容与签名不一致，任何情况下都不该安装。
 */
export function classifyPackageTrust(
  files: PluginPackageFiles,
  trustedPublicKeys: readonly string[],
): PackageTrust {
  const raw = files[PACKAGE_SIGNATURE_FILE];
  if (raw === undefined || raw.trim().length === 0) return 'unsigned';

  let parsed: PackageSignatureFile;
  try {
    parsed = JSON.parse(raw) as PackageSignatureFile;
  } catch {
    return 'tampered';
  }
  if (typeof parsed?.publicKey !== 'string' || typeof parsed?.signature !== 'string') {
    return 'tampered';
  }

  const signer = parseEd25519PublicKey(parsed.publicKey);
  if (!signer) return 'tampered';

  try {
    const intact = verify(
      // Ed25519 自带哈希，algorithm 必须传 null
      null,
      Buffer.from(packageDigest(files), 'utf8'),
      signer,
      Buffer.from(parsed.signature, 'base64'),
    );
    if (!intact) return 'tampered';
  } catch {
    return 'tampered';
  }

  const trusted = trustedPublicKeys
    .map((pem) => parseEd25519PublicKey(pem))
    .filter((key): key is KeyObject => key !== null);
  return trusted.some((key) => sameKey(key, signer)) ? 'first-party' : 'unknown-signer';
}
