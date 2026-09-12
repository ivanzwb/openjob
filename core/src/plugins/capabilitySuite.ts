/**
 * 能力合编包：源码仓库 + 角色扮演 + 案例拆解 打成**一个**单独分发的插件包。
 *
 * 基础包不再内置任何插件（插件页不再有「随应用发布」一栏）；需要这三样能力的用户
 * 从 release 附件下载本包装上。三个能力的工具/交互/解析器实现仍然长在宿主里
 * （tools.ts、rolePlaySession.ts 等），本包只是把它们的**声明**合成一份——与岗位包
 * 一样是纯数据，装进来之后由宿主按 id 接上实现。
 *
 * 三个旧 id（source-repository / role-play / analytics-case@1.0.0）随之退役：
 * - 新战役的 descriptor/binding 一律 pin 本包 id；
 * - 旧战役 pin 的旧 id 按「插件未安装」降级，重选一次岗位即按新 id 重绑；
 * - 旧 id 进入 reserved tombstone（desktop runtime 的 builtInPluginKeys），
 *   防止第三方签一个同 id@version 的包借尸还魂。
 */

import type { CapabilityPlugin, RolePack } from './types';
import { TABULAR_DATASET_ARTIFACT_TYPE, TABULAR_DATASET_SCHEMA_VERSION } from './builtin/analyticsCase/dataset';
import { analyticsCaseCapabilityPlugin } from './builtin/analyticsCase';
import {
  CUSTOMER_CONVERSATION_INTERACTION,
  CUSTOMER_CONVERSATION_SCHEMA_VERSION,
  rolePlayCapabilityPlugin,
} from './builtin/rolePlay';
import { sourceRepositoryCapabilityPlugin } from './builtin/sourceRepository';
import { HOST_CAPABILITY_PLUGINS } from './hostCapabilities';

export const CORE_CAPABILITIES_PACK_ID = 'openjob-capabilities';
export const CORE_CAPABILITIES_PACK_VERSION = '1.0.0';

/** 合编包一并取代的旧内置能力 id。tombstone 与旧 descriptor 识别都用它。 */
export const RETIRED_CAPABILITY_KEYS: readonly string[] = [
  `${sourceRepositoryCapabilityPlugin.manifest.id}@${sourceRepositoryCapabilityPlugin.manifest.version}`,
  `${rolePlayCapabilityPlugin.manifest.id}@${rolePlayCapabilityPlugin.manifest.version}`,
  `${analyticsCaseCapabilityPlugin.manifest.id}@${analyticsCaseCapabilityPlugin.manifest.version}`,
];

/**
 * 旧能力 id → 合编包 id。
 *
 * 历史数据里还躺着三个旧 id：回填出来的 Campaign descriptor、legacyRuntimeDescriptor
 * 的兜底、以及改动前的 binding。它们描述的是历史事实，不能改写（改写会让
 * config_snapshot_hash 跳变），但读的时候必须认得——合编包承载的就是这三份实现，
 * descriptor 里 pin 着旧 id 的战役，装上合编包就算这几项能力可用。
 *
 * 消费方：排程的能力判定（core/planner）与桌面端的能力视图（main/plugins/runtime）。
 */
export const RETIRED_CAPABILITY_ID_TO_SUITE: Readonly<Record<string, string>> = {
  [sourceRepositoryCapabilityPlugin.manifest.id]: CORE_CAPABILITIES_PACK_ID,
  [rolePlayCapabilityPlugin.manifest.id]: CORE_CAPABILITIES_PACK_ID,
  [analyticsCaseCapabilityPlugin.manifest.id]: CORE_CAPABILITIES_PACK_ID,
};

/** 这个能力 id 是否由合编包承载（含它自己的 id 与三个退役 id）。 */
export function capabilityIdResolvedBySuite(id: string): boolean {
  return id === CORE_CAPABILITIES_PACK_ID || RETIRED_CAPABILITY_ID_TO_SUITE[id] !== undefined;
}

/**
 * 把 descriptor 里退役的能力 id 归一成合编包 id，供视图/排程判定使用。
 *
 * 不改写任何落库数据：返回的是给 UI 与排程器看的副本。旧战役在重新选择岗位之前
 * 一直走这条路，重选之后 descriptor 就 pin 新 id 了。
 */
export function normalizeCapabilityRefs<
  T extends { id: string; enabled?: boolean },
>(refs: readonly T[]): T[] {
  return refs.map((ref) => {
    const suiteId = RETIRED_CAPABILITY_ID_TO_SUITE[ref.id];
    return suiteId === undefined ? ref : { ...ref, id: suiteId };
  });
}

/**
 * manifest 取三者并集；register 委托三个原声明——它们只向 registry 注册纯数据
 * （5 个 tool、1 个交互类型、1 个 artifactParser），互不重名，先后顺序无影响。
 */
export const coreCapabilitiesSuite: CapabilityPlugin = {
  manifest: {
    id: CORE_CAPABILITIES_PACK_ID,
    version: CORE_CAPABILITIES_PACK_VERSION,
    type: 'capability',
    displayName: 'OpenJob 能力包',
    description: '源码仓库阅读、客户对话角色扮演、表格案例分析三个能力的合编包。',
    compatibility: {
      core: '^1.0.0',
      schema: 23,
    },
    permissions: ['repository:read', 'llm:complete', 'microphone:read', 'artifact:read'],
    runtime: {
      desktop: 'full',
      mobile: 'view-only',
    },
    artifactSchemas: {
      [TABULAR_DATASET_ARTIFACT_TYPE]: TABULAR_DATASET_SCHEMA_VERSION,
    },
    interactionSchemas: {
      [CUSTOMER_CONVERSATION_INTERACTION]: CUSTOMER_CONVERSATION_SCHEMA_VERSION,
    },
  },
  register(registry) {
    sourceRepositoryCapabilityPlugin.register(registry);
    rolePlayCapabilityPlugin.register(registry);
    analyticsCaseCapabilityPlugin.register(registry);
  },
};

/**
 * 插入点 E：把岗位包的内嵌能力声明合成为套件插件。
 *
 * descriptor 的能力引用形状不变（仍是 openjob-capabilities@<包版本>），下游的
 * 权限网关、能力视图、排程与移动端都不需要知道「声明已经搬进岗位包」——
 * 溶解只改变声明的归属，不改变运行时的消费方式。
 *
 * 权限取所选宿主能力 manifest 的并集（宿主是权限的唯一事实源）；schema 表同理。
 * 声明里没有宿主已知能力时返回 null。
 */
export function synthesizeSuite(
  declaredIds: readonly string[],
  version: string,
  compatibility: { core: string; schema: number },
  sourceLabel: string,
): CapabilityPlugin | null {
  const ids = [...new Set(declaredIds)].filter((id) => HOST_CAPABILITY_PLUGINS.has(id)).sort();
  if (ids.length === 0) return null;

  const plugins = ids.map((id) => HOST_CAPABILITY_PLUGINS.get(id)!);
  const permissions = [
    ...new Set(plugins.flatMap((plugin) => plugin.manifest.permissions)),
  ].sort();
  const artifactSchemas: Record<string, number> = {};
  const interactionSchemas: Record<string, number> = {};
  for (const plugin of plugins) {
    Object.assign(artifactSchemas, plugin.manifest.artifactSchemas ?? {});
    Object.assign(interactionSchemas, plugin.manifest.interactionSchemas ?? {});
  }

  return {
    manifest: {
      id: CORE_CAPABILITIES_PACK_ID,
      version,
      type: 'capability',
      displayName: 'OpenJob 能力包',
      description: `由 ${sourceLabel} 内嵌声明合成的能力集合。`,
      compatibility,
      permissions,
      runtime: {
        desktop: 'full',
        mobile: 'view-only',
      },
      ...(Object.keys(artifactSchemas).length > 0 ? { artifactSchemas } : {}),
      ...(Object.keys(interactionSchemas).length > 0 ? { interactionSchemas } : {}),
    },
    register(registry) {
      for (const plugin of plugins) {
        plugin.register(registry);
      }
    },
  };
}

export function synthesizeSuiteFromRolePack(pack: RolePack): CapabilityPlugin | null {
  return synthesizeSuite(
    (pack.capabilities ?? []).map((item) => item.id),
    pack.manifest.version,
    pack.manifest.compatibility,
    `岗位包 ${pack.manifest.id}@${pack.manifest.version}`,
  );
}
