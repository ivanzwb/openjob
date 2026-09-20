/**
 * 带凭据的旧 Campaign descriptor 的测试夹具。
 *
 * 它与 `descriptorFromRolePack`（回填与兜底走的同一条路径）产出同一份形状：pin 着当前
 * 已装的岗位包与它的内嵌能力。之所以还要这份夹具，是因为用例要一份**不带 resolver** 的
 * descriptor 作为输入——形状必须与生产写出来的一致，否则测的是别的模型。
 *
 * 刻意不含任何历史 id：能力随岗位包分发，descriptor 里 pin 的就是能力自己的 id 与包版本。
 */
import type { CampaignRuntimeDescriptor } from '../types';
import { hashRuntimeConfig } from '../resolver';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';

/**
 * 旧战役的 descriptor 就长这样：pin 着 software-engineering 与它的内嵌能力。
 *
 * 能力引用按**当前**包版本写：能力随岗位包分发，descriptor 与已装包必须对上版本，
 * 否则会判成 pinned-version-unavailable。所以这份夹具跟着包版本走，别再写成历史版本。
 */
const PRE_PLUGIN_ROLE_PACK_REF = {
  id: softwareEngineeringRolePack.manifest.id,
  version: softwareEngineeringRolePack.manifest.version,
} as const;

export function prePluginRuntimeDescriptor(campaignId: string): CampaignRuntimeDescriptor {
  const coreVersion = '1.0.0';
  const schemaVersion = 24;
  const rolePack = { ...PRE_PLUGIN_ROLE_PACK_REF };
  const capabilities: CampaignRuntimeDescriptor['capabilities'] = [
    {
      id: softwareEngineeringRolePack.capabilities[0]!.id,
      version: rolePack.version,
      enabled: true,
    },
  ];
  return {
    campaignId,
    coreVersion,
    rolePack,
    capabilities,
    competencyBaselineVersion: rolePack.version,
    configSnapshotHash: hashRuntimeConfig({
      coreVersion,
      schemaVersion,
      rolePack,
      industryVariantId: undefined,
      capabilities,
      competencyBaselineVersion: rolePack.version,
    }),
    resolvedAt: 0,
  };
}