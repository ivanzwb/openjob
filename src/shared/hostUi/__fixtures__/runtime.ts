/**
 * 宿主界面用例的运行时输入。
 *
 * descriptor 用真的 resolver 解出来，而不是手写一份字面量：这些用例断言的恰恰是
 * 「界面按 resolver 的结果渲染」，输入若是手搓的，`source-repository` 由岗位包可选依赖
 * 自动展开这件事就永远测不到——而它正是能力勾选回校要处理的那种情况。
 */

import {
  buildClientCapabilityView,
  listBuiltInPlugins,
  toInstalledPlugin,
} from '../../plugins/clientView';
import type { ClientCapabilityView } from '../../plugins/clientView';
import { softwareEngineeringRolePack } from '../../plugins/rolePacks/softwareEngineering';
import { sourceRepositoryCapabilityPlugin } from '../../plugins/builtin/sourceRepository';
import { BuiltInPluginRegistry } from '../../plugins/registry';
import { DeterministicRuntimeResolver } from '../../plugins/resolver';
import type { CampaignRuntimeDescriptor, ClientPlatform } from '../../plugins/types';
import type { CampaignRuntimeView } from '../../ipc';
import type { RoleProfile } from '../../entities';

export const CAMPAIGN_ID = 'c-hostui';
export const CORE_VERSION = '1.0.0';
export const SCHEMA_VERSION = 23;

function resolver(): DeterministicRuntimeResolver {
  const registry = new BuiltInPluginRegistry();
  registry.register(softwareEngineeringRolePack);
  registry.registerCapability(sourceRepositoryCapabilityPlugin);
  return new DeterministicRuntimeResolver(registry);
}

export function buildDescriptor(
  options: { rolePackId?: string; capabilityIds?: string[] } = {},
): CampaignRuntimeDescriptor {
  const result = resolver().resolve({
    coreVersion: CORE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    rolePackId: options.rolePackId ?? softwareEngineeringRolePack.manifest.id,
    capabilityIds: options.capabilityIds ?? [],
  });
  if (!result.ok) throw new Error(`fixture 解析失败：${result.error.message}`);
  return { ...result.descriptor, campaignId: CAMPAIGN_ID, resolvedAt: 1_700_000_000_000 };
}

export function buildRuntimeView(
  options: { profile?: Partial<RoleProfile> | null; descriptor?: CampaignRuntimeDescriptor } = {},
): CampaignRuntimeView {
  const descriptor = options.descriptor ?? buildDescriptor();
  const profile: RoleProfile | null =
    options.profile === null
      ? null
      : {
          id: 'rp-hostui',
          roleFamily: descriptor.rolePack.id,
          rolePackId: descriptor.rolePack.id,
          level: null,
          industryPackId: null,
          location: null,
          interviewLanguage: 'zh',
          confidence: 1,
          userConfirmed: true,
          ...options.profile,
        };
  return { descriptor, revision: 1, roleProfile: profile };
}

export function buildCapabilityView(
  descriptor: CampaignRuntimeDescriptor,
  platform: ClientPlatform = 'desktop',
): ClientCapabilityView {
  return buildClientCapabilityView({
    descriptor,
    platform,
    // 岗位包不随应用发布，本机安装集合要显式带上它——只给内置清单就等于在测
    // 「用户还没装岗位包」，而这些用例问的是装好之后界面怎么渲染
    installed: [
      ...listBuiltInPlugins(),
      toInstalledPlugin(softwareEngineeringRolePack.manifest),
    ],
  });
}
