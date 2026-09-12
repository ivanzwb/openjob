/**
 * 让被测进程「装上」岗位包。
 *
 * 基础包不带岗位包，于是任何要解析岗位的用例都得先说明本机装了什么。这不是夹具噪音，
 * 而是被测事实本身：不装就真的解析不出来（`plugin-not-found`），而这正是 P08 要保证的。
 *
 * 走 `setExternalPlugins` 而不是往注册表里塞：装载路径与真实安装完全一致，唯一省掉的是
 * 磁盘扫描——扫描本身由 `inventory.test.ts` 用真实临时目录覆盖。
 */
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { synthesizeSuiteFromRolePack } from '@core/plugins/capabilitySuite';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import type { CapabilityPlugin, RolePack } from '@core/plugins/types';
import type { PluginPackageContributions } from '@core/plugins/package/contract';
import type { PluginInventoryEntry } from '../inventory';
import { setExternalPlugins } from '../runtime';

export function installedRolePackEntry(pack: RolePack): PluginInventoryEntry {
  return {
    dir: `/test/plugins/${pack.manifest.id}@${pack.manifest.version}`,
    trust: 'first-party',
    package: { manifest: pack.manifest, rolePack: pack },
  };
}

/** 合编包的「本机已装」夹具：从 SE 包内嵌声明合成（版本随包 1.4.0）。 */
export function installedCapabilitySuiteEntry(): PluginInventoryEntry {
  const suite = synthesizeSuiteFromRolePack(softwareEngineeringRolePack);
  if (!suite) throw new Error('SE 包合成套件失败');
  const manifest = suite.manifest;
  return {
    dir: `/test/plugins/${manifest.id}@${manifest.version}`,
    trust: 'first-party',
    package: {
      manifest,
      contributions: collectContributions(suite),
    },
  };
}

/** legacy 1.0.0 条目：历史 descriptor pin 退役 id@1.0.0，归一化后按该版本判 installed。 */
export function legacyCapabilitySuiteEntry(): PluginInventoryEntry {
  const suite = synthesizeSuiteFromRolePack(softwareEngineeringRolePack);
  if (!suite) throw new Error('SE 包合成套件失败');
  const manifest = { ...suite.manifest, version: '1.0.0' };
  return {
    dir: `/test/plugins/${manifest.id}@${manifest.version}`,
    trust: 'first-party',
    package: {
      manifest,
      contributions: collectContributions(suite),
    },
  };
}

/** 两个版本一起装：当前 1.4.0 + legacy 1.0.0，与「旧版本仍装着」的生产常态一致。 */
export function installedCapabilitySuiteEntries(): PluginInventoryEntry[] {
  return [installedCapabilitySuiteEntry(), legacyCapabilitySuiteEntry()];
}

function collectContributions(suite: CapabilityPlugin): PluginPackageContributions {
  const collected: { tools: unknown[]; artifactParsers: unknown[]; interactions: unknown[] } = {
    tools: [],
    artifactParsers: [],
    interactions: [],
  };
  suite.register({
    registerTool: (tool) => collected.tools.push(tool),
    registerArtifactParser: (parser) => collected.artifactParsers.push(parser),
    registerInteractionType: (interaction) => collected.interactions.push(interaction),
  });
  return collected as PluginPackageContributions;
}

/** 默认装上全部随 release 分发的包：三个岗位包 + 能力合编包。 */
export function installRolePacks(packs: readonly RolePack[] = DISTRIBUTED_ROLE_PACKS): void {
  setExternalPlugins([...packs.map(installedRolePackEntry), installedCapabilitySuiteEntry()]);
}

/** 回到「一个岗位包都没装」的出厂状态；进程内状态是全局的，用完要还回去。 */
export function uninstallAllPlugins(): void {
  setExternalPlugins([]);
}
