/**
 * 插件化之前 descriptor 的测试夹具。
 *
 * v1.0 发布过：真实用户的数据库里，回填出来的旧 Campaign descriptor 就长这样——
 * pin 着 software-engineering@1.0.0 与 source-repository@1.0.0（当时的内置能力）。
 * 这些行是**历史事实**：config_snapshot_hash 按它们算，练习记录里存的格式 id 也是
 * 那一世的。运行时代码不再有这条冻结路径（旧战役与普通战役统一走
 * descriptorFromRolePack 从已安装岗位包解析），但「旧库的行还能被正确读取与
 * 匹配」必须有测试守着——本夹具就是那些行的替身。
 */
import type { CampaignRuntimeDescriptor } from '../types';
import { hashRuntimeConfig } from '../resolver';

/** 与旧 Campaign 中 pin 的岗位包引用逐字一致的字面量（当时没有包文件，只有这个快照）。 */
const PRE_PLUGIN_ROLE_PACK_REF = { id: 'software-engineering', version: '1.0.0' } as const;

export function prePluginRuntimeDescriptor(campaignId: string): CampaignRuntimeDescriptor {
  const coreVersion = '1.0.0';
  const schemaVersion = 23;
  const rolePack = { ...PRE_PLUGIN_ROLE_PACK_REF };
  const capabilities: CampaignRuntimeDescriptor['capabilities'] = [
    {
      id: 'source-repository',
      version: '1.0.0',
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
      industryPack: undefined,
      capabilities,
      competencyBaselineVersion: rolePack.version,
    }),
    resolvedAt: 0,
  };
}