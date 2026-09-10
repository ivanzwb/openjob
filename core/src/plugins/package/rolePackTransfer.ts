/**
 * 岗位包在「设备之间」的形态。
 *
 * 手机端不安装插件包：它没有 userData/plugins，也验不了 Ed25519（expo-crypto 只有摘要）。
 * 它拿到岗位包的唯一途径是向已配对的桌面端要一份数据——那台桌面在安装时已经验过签名，
 * 而 LAN 通道自身带 HMAC 与版本闸门。这条信任链是「相信自己配对的那台桌面」，不是
 * 「相信这份 JSON」，所以两件事都得做：
 *
 * 1. 结构照样按 P01 的包格式校验一遍，用的是安装路径上同一个 `validatePluginPackage`。
 *    传过来的东西再可信也可能是坏的（版本对不上、字段缺一半），坏数据进了缓存之后，
 *    报错会出现在几百行之外的出题那一步。
 * 2. id 与 version 必须与调用方要的那一对精确相符。descriptor 固定的是精确版本，收下
 *    一个「差不多的版本」等于让手机端按另一套题型和量规练，而 configSnapshotHash 一个
 *    字都不变。
 */
import type { PluginContractIssue } from '../contracts';
import type { PluginManifest, RolePack } from '../types';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  validatePluginPackage,
  type PluginPackageFiles,
} from './contract';

/**
 * 岗位包 → 包内文件。`scripts/pack-plugins.mjs` 打发布包时走的也是这里，
 * 「岗位包怎么拆成 manifest.json + pack.json」只有这一处定义。
 */
export function rolePackToPackageFiles(pack: RolePack): PluginPackageFiles {
  const { manifest, ...rest } = pack;
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
    [PACKAGE_PACK_FILE]: JSON.stringify(rest),
  };
}

export type RolePackTransferResult =
  | { ok: true; pack: RolePack }
  | { ok: false; detail: string };

function describe(issues: readonly PluginContractIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('；');
}

/**
 * 校验一份从桌面端取回的岗位包，并确认它就是 `expected` 那一版。
 *
 * 对任何输入都返回结果对象，不抛：调用方在同步路径上，一次意外抛出会把整轮同步打断，
 * 而真实原因只是对端给了一个 null。
 */
export function parseTransferredRolePack(
  value: unknown,
  expected: { id: string; version: string },
): RolePackTransferResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, detail: '桌面端没有返回岗位包数据' };
  }

  const manifest = (value as { manifest?: unknown }).manifest;
  if (typeof manifest !== 'object' || manifest === null) {
    return { ok: false, detail: '岗位包缺少 manifest' };
  }
  const { id, version } = manifest as PluginManifest;
  if (id !== expected.id || version !== expected.version) {
    return {
      ok: false,
      detail: `拿到的是 ${String(id)}@${String(version)}，要的是 ${expected.id}@${expected.version}`,
    };
  }

  let files: PluginPackageFiles;
  try {
    files = rolePackToPackageFiles(value as RolePack);
  } catch (error) {
    return { ok: false, detail: `岗位包无法序列化：${(error as Error).message}` };
  }

  const issues = validatePluginPackage(files);
  if (issues.length > 0) return { ok: false, detail: describe(issues) };

  return { ok: true, pack: value as RolePack };
}
