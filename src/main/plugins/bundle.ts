/**
 * 打包与签名。发布侧（P09 的 CI 脚本）和测试共用同一段逻辑。
 *
 * 与 install.ts 的 parseBundle 严格互逆：任何一方单独改动，测试里的往返用例会立刻发现。
 */
import { sign, type KeyObject } from 'node:crypto';
import {
  PACKAGE_SIGNATURE_FILE,
  type PluginPackageFiles,
} from '@shared/plugins/package/contract';
import { packageDigest } from './package/signature';

export interface SignedBundle {
  files: PluginPackageFiles;
}

/** 用发布私钥给一组包内文件签名，返回带签名文件的完整集合。 */
export function signPackageFiles(
  files: PluginPackageFiles,
  privateKey: KeyObject,
  publicKeyPem: string,
): PluginPackageFiles {
  const signature = sign(null, Buffer.from(packageDigest(files), 'utf8'), privateKey);
  return {
    ...files,
    // 签名文件内嵌公钥：校验侧要靠它区分「内容被篡改」和「换了个签名者」
    [PACKAGE_SIGNATURE_FILE]: JSON.stringify({
      publicKey: publicKeyPem,
      signature: signature.toString('base64'),
    }),
  };
}

export function toBundleJson(files: PluginPackageFiles): string {
  return JSON.stringify({ files } satisfies SignedBundle);
}
