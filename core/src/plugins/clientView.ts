/**
 * 本机能力视图。
 *
 * 依赖解析只发生在 resolver 一处，桌面和手机消费同一份 CampaignRuntimeDescriptor。
 * 本模块只读 descriptor 与本机已安装 Manifest，计算当前设备的降级状态：
 * 不重新展开依赖，也不写回 Campaign binding。
 */
import type { PluginType, RuntimeAvailability } from '../enums';
import { BUILT_IN_PLUGIN_MANIFESTS } from './builtin';
import type { PluginPermission } from './permissions';
import type {
  CampaignRuntimeDescriptor,
  ClientPlatform,
  PluginManifest,
  PluginRuntimeAvailability,
} from './types';

export type ClientCapabilityMode = RuntimeAvailability;

export type ClientDegradationReason =
  /** descriptor 已把该能力标为未启用，与本机无关。 */
  | 'capability-disabled'
  | 'plugin-not-installed'
  | 'pinned-version-unavailable'
  | 'platform-view-only'
  /** 外置能力插件在手机端一律只读，不看它自己声明成什么。 */
  | 'external-capability-desktop-only'
  | 'platform-unsupported'
  | 'artifact-schema-unknown'
  | 'interaction-schema-unknown';

/** 本机安装的插件摘要，由 Manifest 投影而来，不包含可执行内容。 */
export interface InstalledPlugin {
  id: string;
  version: string;
  type: PluginType;
  displayName: string;
  description: string;
  /** Role/Industry Pack 允许不声明运行能力，此时按 full 处理。 */
  runtime: PluginRuntimeAvailability | null;
  artifactSchemas: Record<string, number>;
  interactionSchemas: Record<string, number>;
  permissions: PluginPermission[];
  /** 代码入口（v3）：存在时该插件会进入激活生命周期 */
  main: string | null;
  api: string | null;
}

export interface ArtifactSchemaRef {
  capabilityId: string;
  artifactType: string;
  /** 数据自身声明的 schema 版本。 */
  schemaVersion: number;
}

export interface ClientArtifactView extends ArtifactSchemaRef {
  /** 本机固定版本声明的 schema 版本；不认识该 artifact 时为 null。 */
  knownSchemaVersion: number | null;
  parsable: boolean;
  reason: ClientDegradationReason | null;
}

export interface ClientPluginStatus {
  id: string;
  /** descriptor 固定的精确版本；未安装的可选依赖没有可固定版本。 */
  version: string | null;
  installed: boolean;
  mode: ClientCapabilityMode;
  reason: ClientDegradationReason | null;
  /** 面向用户的降级说明；mode 为 full 时为 null。 */
  detail: string | null;
}

export interface ClientCapabilityView {
  campaignId: string;
  platform: ClientPlatform;
  coreVersion: string;
  /** 与 descriptor 逐字相同，用于核对两端消费的是同一次解析结果。 */
  configSnapshotHash: string;
  resolvedAt: number;
  rolePack: ClientPluginStatus;
  industryPack: ClientPluginStatus | null;
  capabilities: ClientPluginStatus[];
  enabledCapabilityIds: string[];
  readOnlyCapabilityIds: string[];
  unsupportedCapabilityIds: string[];
  artifacts: ClientArtifactView[];
  /** 本机能力低于 descriptor；descriptor 自身禁用的能力不计入。 */
  degraded: boolean;
}

export interface ClientCapabilityViewInput {
  descriptor: CampaignRuntimeDescriptor;
  platform: ClientPlatform;
  installed: readonly InstalledPlugin[];
  artifacts?: readonly ArtifactSchemaRef[];
}

const DEGRADATION_DETAILS: Record<ClientDegradationReason, string> = {
  'capability-disabled': '本次 Campaign 未启用该插件',
  'plugin-not-installed': '本机未安装该插件，只能查看历史结果',
  'pinned-version-unavailable': '本机没有 Campaign 固定的插件版本，只能查看历史结果',
  'platform-view-only': '当前设备只支持查看，需在桌面端执行',
  'external-capability-desktop-only': '单独安装的能力插件只能在桌面端执行，手机端只能查看',
  'platform-unsupported': '当前设备不支持该能力',
  'artifact-schema-unknown': '本机不认识该 artifact 的 schema 版本，只保留同步与查看',
  'interaction-schema-unknown': '本机不认识该交互的 schema 版本，只保留同步与查看',
};

interface InstalledIndex {
  ids: Set<string>;
  exact: Map<string, InstalledPlugin>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function buildIndex(installed: readonly InstalledPlugin[]): InstalledIndex {
  const index: InstalledIndex = { ids: new Set(), exact: new Map() };
  installed.forEach((plugin) => {
    index.ids.add(plugin.id);
    index.exact.set(exactKey(plugin.id, plugin.version), plugin);
  });
  return index;
}

export function toInstalledPlugin(manifest: PluginManifest): InstalledPlugin {
  return {
    id: manifest.id,
    version: manifest.version,
    type: manifest.type,
    displayName: manifest.displayName,
    description: manifest.description,
    runtime: manifest.runtime ? { ...manifest.runtime } : null,
    artifactSchemas: { ...(manifest.artifactSchemas ?? {}) },
    interactionSchemas: { ...(manifest.interactionSchemas ?? {}) },
    permissions: [...manifest.permissions],
    main: manifest.main ?? null,
    api: manifest.api ?? null,
  };
}

export { BUILT_IN_PLUGIN_MANIFESTS };

/**
 * 随应用发布的那部分插件，**不等于本机安装清单**。
 *
 * 岗位包由用户单独安装，所以完整清单只有主进程知道（`main/plugins/runtime.ts` 的
 * `listInstalledPlugins`）。拿这个函数当 `buildClientCapabilityView` 的 `installed`，
 * 表达的是「一个岗位包都没装」——那会把所有战役判成 view-only。
 */

export function listBuiltInPlugins(): InstalledPlugin[] {
  return BUILT_IN_PLUGIN_MANIFESTS.map(toInstalledPlugin).sort(
    (left, right) =>
      compareStrings(left.id, right.id) || compareStrings(left.version, right.version),
  );
}

function degradedStatus(
  id: string,
  version: string | null,
  installed: boolean,
  mode: ClientCapabilityMode,
  reason: ClientDegradationReason,
  detail = DEGRADATION_DETAILS[reason],
): ClientPluginStatus {
  return { id, version, installed, mode, reason, detail };
}

/**
 * 随应用发布的 `id@version`。
 *
 * 外置包不允许占用这些键（见 `main/plugins/inventory.ts` 的 reservedKeys），所以
 * 「不在这个集合里」就等价于「这个包是用户自己装进来的」。
 */
const BUILT_IN_KEYS = new Set(
  BUILT_IN_PLUGIN_MANIFESTS.map((manifest) => exactKey(manifest.id, manifest.version)),
);

/**
 * 本机对某个已安装插件的运行能力，外加降级原因。
 *
 * 手机端对外置**能力插件**有一条硬上限：不管它自己声明成什么，最高只到 view-only。
 * `runtime.mobile` 是包作者填的一句声明，而能力插件贡献的只是声明，工具的真实实现全在
 * 宿主里（见 `package/contract.ts` 开头）——手机端一行插件代码都不装载，也没有那些工具。
 * 信了这句声明，界面就会在手机上摆出一个按下去什么都不会发生的执行入口，排程还会把它
 * 算进「本机能做的事」。
 *
 * 岗位包不在此列：它是纯数据，手机端拿到就能用，这正是 P10 要把它下发过去的理由。
 */
function localAvailability(
  plugin: InstalledPlugin,
  platform: ClientPlatform,
): { mode: ClientCapabilityMode; reason: ClientDegradationReason | null } {
  const declared = plugin.runtime?.[platform] ?? 'full';
  const externalCapability =
    plugin.type === 'capability' && !BUILT_IN_KEYS.has(exactKey(plugin.id, plugin.version));

  if (declared === 'full') {
    return platform === 'mobile' && externalCapability
      ? { mode: 'view-only', reason: 'external-capability-desktop-only' }
      : { mode: 'full', reason: null };
  }
  return {
    mode: declared,
    reason: declared === 'view-only' ? 'platform-view-only' : 'platform-unsupported',
  };
}

function pluginStatus(
  id: string,
  version: string | null,
  platform: ClientPlatform,
  index: InstalledIndex,
  disabledReason?: string,
): ClientPluginStatus {
  const exact = version === null ? undefined : index.exact.get(exactKey(id, version));

  if (disabledReason !== undefined) {
    return degradedStatus(
      id,
      version,
      exact !== undefined,
      'unsupported',
      'capability-disabled',
      `${DEGRADATION_DETAILS['capability-disabled']}：${disabledReason}`,
    );
  }

  // 固定版本不可用时历史结果仍可查看，但不能改用其它版本重跑。
  if (!exact) {
    return degradedStatus(
      id,
      version,
      false,
      'view-only',
      index.ids.has(id) ? 'pinned-version-unavailable' : 'plugin-not-installed',
    );
  }

  const local = localAvailability(exact, platform);
  if (local.reason === null) {
    return { id, version, installed: true, mode: 'full', reason: null, detail: null };
  }
  return degradedStatus(id, version, true, local.mode, local.reason);
}

function artifactView(
  ref: ArtifactSchemaRef,
  descriptor: CampaignRuntimeDescriptor,
  statuses: ClientPluginStatus[],
  index: InstalledIndex,
): ClientArtifactView {
  const status = statuses.find((item) => item.id === ref.capabilityId) ?? null;
  const pinned = descriptor.capabilities.find((item) => item.id === ref.capabilityId);
  const installed =
    pinned?.enabled && pinned.version
      ? index.exact.get(exactKey(ref.capabilityId, pinned.version))
      : undefined;

  if (!installed || status?.mode === 'unsupported') {
    return {
      ...ref,
      knownSchemaVersion: null,
      parsable: false,
      reason: status?.reason ?? 'plugin-not-installed',
    };
  }

  const knownSchemaVersion = installed.artifactSchemas[ref.artifactType] ?? null;
  // 认不出的 schema 版本一律只读：猜着解析会把错误结构写进 Campaign。
  const parsable = knownSchemaVersion !== null && ref.schemaVersion <= knownSchemaVersion;
  return {
    ...ref,
    knownSchemaVersion,
    parsable,
    reason: parsable ? null : 'artifact-schema-unknown',
  };
}

export function buildClientCapabilityView(
  input: ClientCapabilityViewInput,
): ClientCapabilityView {
  const { descriptor, platform } = input;
  const index = buildIndex(input.installed);

  const rolePack = pluginStatus(
    descriptor.rolePack.id,
    descriptor.rolePack.version,
    platform,
    index,
  );
  const industryPack = descriptor.industryPack
    ? pluginStatus(descriptor.industryPack.id, descriptor.industryPack.version, platform, index)
    : null;

  const capabilities = [...descriptor.capabilities]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((ref) =>
      ref.enabled
        ? pluginStatus(ref.id, ref.version, platform, index)
        : pluginStatus(ref.id, ref.version ?? null, platform, index, ref.disabledReason),
    );

  const artifacts = (input.artifacts ?? []).map((ref) =>
    artifactView(ref, descriptor, capabilities, index),
  );

  const idsWithMode = (mode: ClientCapabilityMode): string[] =>
    capabilities.filter((item) => item.mode === mode).map((item) => item.id);

  const locallyDegraded = (status: ClientPluginStatus): boolean =>
    status.mode !== 'full' && status.reason !== 'capability-disabled';

  return {
    campaignId: descriptor.campaignId,
    platform,
    coreVersion: descriptor.coreVersion,
    configSnapshotHash: descriptor.configSnapshotHash,
    resolvedAt: descriptor.resolvedAt,
    rolePack,
    industryPack,
    capabilities,
    enabledCapabilityIds: idsWithMode('full'),
    readOnlyCapabilityIds: idsWithMode('view-only'),
    unsupportedCapabilityIds: idsWithMode('unsupported'),
    artifacts,
    degraded:
      locallyDegraded(rolePack) ||
      (industryPack !== null && locallyDegraded(industryPack)) ||
      capabilities.some(locallyDegraded) ||
      artifacts.some((artifact) => !artifact.parsable),
  };
}

/** 未出现在 descriptor 中的能力等同于不可用，不允许按 ID 猜测。 */
export function capabilityMode(
  view: ClientCapabilityView,
  capabilityId: string,
): ClientCapabilityMode {
  return view.capabilities.find((item) => item.id === capabilityId)?.mode ?? 'unsupported';
}

export function canParseArtifact(view: ClientCapabilityView, ref: ArtifactSchemaRef): boolean {
  return view.artifacts.some(
    (artifact) =>
      artifact.capabilityId === ref.capabilityId &&
      artifact.artifactType === ref.artifactType &&
      artifact.schemaVersion === ref.schemaVersion &&
      artifact.parsable,
  );
}
