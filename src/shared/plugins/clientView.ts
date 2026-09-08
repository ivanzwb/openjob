/**
 * 本机能力视图。
 *
 * 依赖解析只发生在 resolver 一处，桌面和手机消费同一份 CampaignRuntimeDescriptor。
 * 本模块只读 descriptor 与本机已安装 Manifest，计算当前设备的降级状态：
 * 不重新展开依赖，也不写回 Campaign binding。
 */
import type { PluginType, RuntimeAvailability } from '../enums';
import { softwareEngineeringRolePack } from './builtin/softwareEngineering';
import { sourceRepositoryCapabilityPlugin } from './builtin/sourceRepository';
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
  | 'platform-unsupported'
  | 'artifact-schema-unknown';

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
  permissions: PluginPermission[];
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
  'platform-unsupported': '当前设备不支持该能力',
  'artifact-schema-unknown': '本机不认识该 artifact 的 schema 版本，只保留同步与查看',
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
    permissions: [...manifest.permissions],
  };
}

/** Phase 0 的插件全部随应用发布，安装清单即内置清单。 */
export const BUILT_IN_PLUGIN_MANIFESTS: readonly PluginManifest[] = [
  softwareEngineeringRolePack.manifest,
  sourceRepositoryCapabilityPlugin.manifest,
];

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

  const availability = exact.runtime?.[platform] ?? 'full';
  if (availability === 'full') {
    return { id, version, installed: true, mode: 'full', reason: null, detail: null };
  }
  return degradedStatus(
    id,
    version,
    true,
    availability,
    availability === 'view-only' ? 'platform-view-only' : 'platform-unsupported',
  );
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
