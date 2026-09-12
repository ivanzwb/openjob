/**
 * 能力合编包（openjob-capabilities）的兼容层。
 *
 * v1.0 里三个能力是随应用发布的内置插件，后来合并成单独分发的合编包；
 * v3 起声明归岗位包所有（CapabilityDeclaration 内嵌 tools/interactions/
 * parsers），这里的职责只剩两件：
 *
 * 1. `synthesizeSuite`：把岗位包的内嵌声明合成为 descriptor 里的能力引用
 *    （形状不变，下游网关/视图/排程/移动端零改动）；
 * 2. retired-key 归一：历史数据里 pin 着三个旧能力 id，读的时候必须认得。
 *
 * core 在这里依然**不认识任何具体能力**：合成器只做声明的搬运与归集，
 * 权限取自声明本身，实现绑定是 desktop main 的事。
 */

import type { CapabilityDeclaration, CapabilityPlugin, PluginPermission, RolePack } from './types';

export const CORE_CAPABILITIES_PACK_ID = 'openjob-capabilities';
export const CORE_CAPABILITIES_PACK_VERSION = '1.0.0';

/** 合编包一并取代的旧内置能力 id。tombstone 与旧 descriptor 识别都用它。 */
export const RETIRED_CAPABILITY_KEYS: readonly string[] = [
  'source-repository@1.0.0',
  'role-play@1.0.0',
  'analytics-case@1.0.0',
];

/** 旧能力 id → 合编包 id。消费方：排程的能力判定与桌面端的能力视图。 */
export const RETIRED_CAPABILITY_ID_TO_SUITE: Readonly<Record<string, string>> = {
  'source-repository': CORE_CAPABILITIES_PACK_ID,
  'role-play': CORE_CAPABILITIES_PACK_ID,
  'analytics-case': CORE_CAPABILITIES_PACK_ID,
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
 * 把岗位包的内嵌能力声明合成为套件插件。
 *
 * descriptor 的能力引用形状不变（openjob-capabilities@<包版本>），下游消费方式
 * 不变——溶解只改变声明的归属，不改变运行时的消费方式。声明归包所有，这里
 * 只搬运：权限取各声明 tools/interactions/parsers 里 permission 字段的并集。
 */
export function synthesizeSuite(
  declarations: readonly CapabilityDeclaration[],
  version: string,
  compatibility: { core: string; schema: number },
  sourceLabel: string,
): CapabilityPlugin | null {
  const declared = declarations.filter(
    (item) =>
      (item.tools?.length ?? 0) + (item.interactions?.length ?? 0) + (item.artifactParsers?.length ?? 0) >
      0,
  );
  if (declared.length === 0) return null;

  const permissions = [
    ...new Set<PluginPermission>(
      declared.flatMap((declaration) => [
        ...(declaration.tools ?? []).map((tool) => tool.permission),
        ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
      ]),
    ),
  ].sort();

  const artifactSchemas: Record<string, number> = {};
  const interactionSchemas: Record<string, number> = {};
  for (const declaration of declared) {
    for (const parser of declaration.artifactParsers ?? []) {
      artifactSchemas[parser.artifactType] = parser.schemaVersion;
    }
    for (const interaction of declaration.interactions ?? []) {
      interactionSchemas[interaction.type] = interaction.schemaVersion;
    }
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
      for (const declaration of declared) {
        for (const tool of declaration.tools ?? []) registry.registerTool(tool);
        for (const parser of declaration.artifactParsers ?? []) {
          registry.registerArtifactParser(parser);
        }
        for (const interaction of declaration.interactions ?? []) {
          registry.registerInteractionType(interaction);
        }
      }
    },
  };
}

export function synthesizeSuiteFromRolePack(pack: RolePack): CapabilityPlugin | null {
  return synthesizeSuite(
    pack.capabilities ?? [],
    pack.manifest.version,
    pack.manifest.compatibility,
    `岗位包 ${pack.manifest.id}@${pack.manifest.version}`,
  );
}
