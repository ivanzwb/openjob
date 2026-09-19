/**
 * 岗位包内嵌能力的两种投影。
 *
 * 能力**不是**独立的包：声明归岗位包所有，随包分发、随包版本化（`CapabilityDeclaration`）。
 * 所以「本机有没有这个能力」= 声明它的那个岗位包在不在本机，而 `capabilityEntriesFromRolePack`
 * 就是这份判定的载体——clientView 按 `能力 id@包版本` 找它，权限网关按能力 id 取它声明的权限。
 *
 * 这里没有「合编包」这一层：一个包声明三个能力，就是三条各自独立的清单项。
 */
import { toInstalledPlugin, type InstalledPlugin } from './clientView';
import type {
  CapabilityDeclaration,
  CapabilityPlugin,
  PluginManifest,
  PluginPermission,
  RolePack,
} from './types';

/**
 * 能力的运行时可用性：实现全在桌面主进程（工具、解析器、交互宿主），手机端只读。
 *
 * 与岗位包自己那条清单项不同——岗位包的声明是纯数据，两端都能用；能力要执行，只有桌面能。
 */
const CAPABILITY_RUNTIME = { desktop: 'full', mobile: 'view-only' } as const;

/**
 * 一条声明是否产生本机可寻址的能力条目。
 *
 * 注册内容、权限、LLM 角色有其一即可：只有权限与角色的能力（页面自己编排通用原语）同样
 * 要进清单——clientView 判定「本机有没有这个能力」、权限网关推导契约都靠它。
 */
function declaresSomething(declaration: CapabilityDeclaration): boolean {
  return (
    (declaration.tools?.length ?? 0) +
      (declaration.interactions?.length ?? 0) +
      (declaration.artifactParsers?.length ?? 0) +
      (declaration.permissions?.length ?? 0) +
      (declaration.llmRoles?.length ?? 0) >
    0
  );
}

/** 该声明实际需要的权限：各贡献自带的 permission 加上声明级 permissions 的并集。 */
function declarationPermissions(declaration: CapabilityDeclaration): PluginPermission[] {
  return [
    ...new Set<PluginPermission>([
      ...(declaration.tools ?? []).map((tool) => tool.permission),
      ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
      ...(declaration.permissions ?? []),
    ]),
  ].sort();
}

function declarationManifest(pack: RolePack, declaration: CapabilityDeclaration): PluginManifest {
  const artifactSchemas: Record<string, number> = {};
  for (const parser of declaration.artifactParsers ?? []) {
    artifactSchemas[parser.artifactType] = parser.schemaVersion;
  }
  const interactionSchemas: Record<string, number> = {};
  for (const interaction of declaration.interactions ?? []) {
    interactionSchemas[interaction.type] = interaction.schemaVersion;
  }

  return {
    // 能力用**自己的** id。宿主按名字绑定实现（如 source-repository 的实现住在宿主的能力实现目录），
    // 而这条 id 同时是 descriptor 的能力引用、权限契约的 key 与 binding 行的 plugin_id。
    id: declaration.id,
    version: pack.manifest.version,
    type: 'capability',
    displayName: pack.manifest.displayName,
    description: pack.manifest.description,
    compatibility: pack.manifest.compatibility,
    permissions: declarationPermissions(declaration),
    runtime: { ...CAPABILITY_RUNTIME },
    ...(Object.keys(artifactSchemas).length > 0 ? { artifactSchemas } : {}),
    ...(Object.keys(interactionSchemas).length > 0 ? { interactionSchemas } : {}),
  };
}

/**
 * 岗位包声明的能力 → 本机「已安装能力」清单项，一条声明一条。
 *
 * 排序与 id 唯一由调用方（本机清单）负责；这里只保证形状与岗位包版本一致。
 */
export function capabilityEntriesFromRolePack(pack: RolePack): InstalledPlugin[] {
  return (pack.capabilities ?? [])
    .filter(declaresSomething)
    .map((declaration) => toInstalledPlugin(declarationManifest(pack, declaration)));
}

/**
 * 把岗位包的内嵌声明重放成一个可供注册校验的插件视图（owner 是岗位包自己）。
 *
 * resolver 用它跑装载期的那套校验：贡献 id 不重复、权限与 manifest 一致、schema 版本与
 * manifest 声明对得上。没有这一步，包内声明的错误要等到运行时调用才暴露。
 */
export function rolePackDeclarationPlugin(pack: RolePack): CapabilityPlugin {
  return {
    manifest: pack.manifest,
    register(registry) {
      for (const declaration of pack.capabilities ?? []) {
        for (const tool of declaration.tools ?? []) registry.registerTool(tool);
        for (const parser of declaration.artifactParsers ?? []) registry.registerArtifactParser(parser);
        for (const interaction of declaration.interactions ?? []) {
          registry.registerInteractionType(interaction);
        }
      }
    },
  };
}
