/**
 * Campaign 运行时读写的唯一入口。
 *
 * 插件依赖解析只在这里发生一次，写库后由 descriptor 承担跨端事实源；
 * 桌面渲染层和手机端都只消费 descriptor，再各自计算本机降级视图。
 *
 * 本模块不引用 ../db：所有函数接收 raw Database，由 IPC/RPC 层注入，
 * 这样迁移后的真实库结构可以直接进单测。
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type {
  CampaignRuntimeView,
  ClientCapabilityViewRequest,
  SetRoleProfileInput,
} from '@core/ipc';
import { RETIRED_CAPABILITY_KEYS } from '@core/plugins/capabilitySuite';
import {
  buildClientCapabilityView,
  listBuiltInPlugins,
  toInstalledPlugin,
  type ClientCapabilityView,
  type InstalledPlugin,
} from '@core/plugins/clientView';
import { toCapabilityPlugin } from '@core/plugins/package/replay';
import { BuiltInPluginRegistry } from '@core/plugins/registry';
import { DeterministicRuntimeResolver } from '@core/plugins/resolver';
import type {
  CampaignRuntimeDescriptor,
  ResolvedCapabilityRef,
  ResolvedPluginRef,
  RolePack,
} from '@core/plugins/types';
import type { RoleProfile } from '@core/entities';
import {
  LEGACY_CORE_VERSION,
  LEGACY_SCHEMA_VERSION,
} from '../db/backfill/pluginRuntime';
import type { PluginInventoryEntry } from './inventory';

/** 与 backfill 共用同一组常量，回填出来的旧 Campaign 与新写入的 hash 才可比。 */
export const CORE_VERSION = LEGACY_CORE_VERSION;
export const RUNTIME_SCHEMA_VERSION = LEGACY_SCHEMA_VERSION;

interface DescriptorRow {
  revision: number;
  core_version: string;
  role_pack: string;
  industry_pack: string | null;
  capabilities: string;
  competency_baseline_version: string;
  config_snapshot_hash: string;
  resolved_at: number;
}

interface RoleProfileRow {
  id: string;
  role_family: string;
  role_pack_id: string;
  level: string | null;
  industry_pack_id: string | null;
  location: string | null;
  interview_language: string;
  confidence: number;
  user_confirmed: number;
}

/**
 * 本机装了的外置插件。
 *
 * 模块级可变状态是刻意的：扫描要碰文件系统，不能发生在本模块（它被单测直接加载，
 * 而且刻意不依赖 ../db 与 electron）。启动流程扫完之后调 setExternalPlugins 注入。
 */
let externalEntries: readonly PluginInventoryEntry[] = [];

/**
 * 外置包装配进注册表，走的是与内置完全相同的契约入口。
 *
 * 岗位包直接就是数据；能力插件把录下来的声明重放一遍（见 package/replay.ts），
 * 全程不执行任何外部代码。
 */
function registerExternal(registry: BuiltInPluginRegistry, entry: PluginInventoryEntry): void {
  const { manifest, rolePack, contributions } = entry.package;
  // 按 manifest.type 分派，而不是按哪个字段有值：两者本该一致（格式校验强制 type 与文件
  // 对应），真不一致时应当明确报错，而不是让 type 与实际注册方式静默分叉
  switch (manifest.type) {
    case 'role-pack':
      if (!rolePack) throw new Error(`岗位包缺少数据：${manifest.id}`);
      registry.register(rolePack);
      return;
    case 'capability':
      if (!contributions) throw new Error(`能力插件缺少 contributions：${manifest.id}`);
      registry.registerCapability(toCapabilityPlugin(manifest, contributions));
      return;
    default:
      registry.registerIndustryPack(manifest);
  }
}

function createRegistry(): BuiltInPluginRegistry {
  const registry = new BuiltInPluginRegistry();
  // 基础包不再内置任何插件：能力来自单独安装的 openjob-capabilities 合编包，
  // 岗位包来自用户安装。这里只装配本机安装清单，注册顺序即扫描顺序。
  externalEntries.forEach((entry) => registerExternal(registry, entry));
  return registry;
}

let registry = createRegistry();
let resolver = new DeterministicRuntimeResolver(registry);

/**
 * 内置占用的 `id@version`，外置包不允许顶替。
 *
 * 内置清单清空后这个集合退化为**退役名册**：三个旧能力 id@1.0.0（改动前随应用
 * 发布）仍被保留——存量战役的 descriptor/binding pin 着它们，若不占位，任何第三方
 * 可以签一个同 id@version 的包装进来，借尸还魂拿到对应的权限契约与「已安装」判定。
 */
export function builtInPluginKeys(): Set<string> {
  return new Set([...RETIRED_CAPABILITY_KEYS]);
}

/**
 * 替换外置插件集合并重建解析器。
 *
 * 整体重建而不是增量往注册表里塞：BuiltInPluginRegistry 不允许同 id@version 覆盖，
 * 增量注册在「卸载后重装」时必然撞车，而且解析结果会依赖注册顺序。
 */
export function setExternalPlugins(entries: readonly PluginInventoryEntry[]): void {
  externalEntries = [...entries];
  registry = createRegistry();
  resolver = new DeterministicRuntimeResolver(registry);
}

/**
 * 按精确版本取本机已安装的岗位包，没装返回 null。
 *
 * 走注册表而不是自己遍历 externalEntries：注册表是解析用的同一份集合，两处各查一遍时，
 * 「能选上但练不了」这类分叉会在最难查的地方出现——岗位选好了、descriptor 也写了，
 * 到出题那一步才说没这个包。
 */
export function findInstalledRolePack(id: string, version: string): RolePack | null {
  return registry.get(id, version);
}

export function listExternalPlugins(): readonly PluginInventoryEntry[] {
  return externalEntries;
}

export function listInstalledPlugins(): InstalledPlugin[] {
  return [
    ...listBuiltInPlugins(),
    ...externalEntries.map((entry) => toInstalledPlugin(entry.package.manifest)),
  ].sort(
    (left, right) =>
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) ||
      (left.version < right.version ? -1 : left.version > right.version ? 1 : 0),
  );
}

function rowToRoleProfile(row: RoleProfileRow): RoleProfile {
  return {
    id: row.id,
    roleFamily: row.role_family,
    rolePackId: row.role_pack_id,
    level: row.level,
    industryPackId: row.industry_pack_id,
    location: row.location,
    interviewLanguage: row.interview_language,
    confidence: row.confidence,
    userConfirmed: row.user_confirmed === 1,
  };
}

function readRoleProfile(raw: Database, campaignId: string): RoleProfile | null {
  const row = raw
    .prepare(
      `SELECT p.* FROM role_profile p
       JOIN campaign c ON c.role_profile_id = p.id
       WHERE c.id = ?`,
    )
    .get(campaignId) as RoleProfileRow | undefined;
  return row ? rowToRoleProfile(row) : null;
}

function readDescriptor(raw: Database, campaignId: string): CampaignRuntimeView | null {
  const row = raw
    .prepare(
      `SELECT revision, core_version, role_pack, industry_pack, capabilities,
              competency_baseline_version, config_snapshot_hash, resolved_at
       FROM campaign_runtime_descriptor
       WHERE campaign_id = ?
       ORDER BY revision DESC
       LIMIT 1`,
    )
    .get(campaignId) as DescriptorRow | undefined;
  if (!row) return null;

  const descriptor: CampaignRuntimeDescriptor = {
    campaignId,
    coreVersion: row.core_version,
    rolePack: JSON.parse(row.role_pack) as ResolvedPluginRef,
    industryPack: row.industry_pack
      ? (JSON.parse(row.industry_pack) as ResolvedPluginRef)
      : undefined,
    capabilities: JSON.parse(row.capabilities) as ResolvedCapabilityRef[],
    competencyBaselineVersion: row.competency_baseline_version,
    configSnapshotHash: row.config_snapshot_hash,
    resolvedAt: row.resolved_at,
  };
  return { descriptor, revision: row.revision, roleProfile: readRoleProfile(raw, campaignId) };
}

export function getCampaignRuntime(
  raw: Database,
  campaignId: string,
): CampaignRuntimeView | null {
  return readDescriptor(raw, campaignId);
}

export interface SetRoleProfileOptions {
  now?: () => number;
}

/**
 * 写入岗位意图并激活新的 binding revision。
 *
 * 解析失败时不写任何一行：Campaign 保留上一份有效 descriptor，不允许部分激活。
 */
export function setCampaignRoleProfile(
  raw: Database,
  input: SetRoleProfileInput,
  options: SetRoleProfileOptions = {},
): CampaignRuntimeView {
  const campaign = raw
    .prepare(`SELECT id, role_profile_id FROM campaign WHERE id = ?`)
    .get(input.campaignId) as { id: string; role_profile_id: string | null } | undefined;
  if (!campaign) throw new Error(`Campaign 不存在：${input.campaignId}`);

  const resolved = resolver.resolve({
    coreVersion: CORE_VERSION,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    rolePackId: input.rolePackId,
    industryPackId: input.industryPackId ?? undefined,
    capabilityIds: input.capabilityIds ?? [],
  });
  if (!resolved.ok) {
    throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  }

  const snapshot = resolved.descriptor;
  const timestamp = options.now?.() ?? Date.now();
  const roleProfileId = campaign.role_profile_id ?? randomUUID();

  const activate = raw.transaction(() => {
    if (campaign.role_profile_id) {
      raw
        .prepare(
          `UPDATE role_profile
           SET role_family = ?, role_pack_id = ?, level = ?, industry_pack_id = ?,
               location = ?, interview_language = ?, confidence = ?, user_confirmed = ?
           WHERE id = ?`,
        )
        .run(
          input.roleFamily,
          input.rolePackId,
          input.level ?? null,
          input.industryPackId ?? null,
          input.location ?? null,
          input.interviewLanguage ?? 'zh',
          input.confidence ?? 1,
          input.userConfirmed === false ? 0 : 1,
          roleProfileId,
        );
    } else {
      raw
        .prepare(
          `INSERT INTO role_profile (
             id, role_family, role_pack_id, level, industry_pack_id, location,
             interview_language, confidence, user_confirmed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          roleProfileId,
          input.roleFamily,
          input.rolePackId,
          input.level ?? null,
          input.industryPackId ?? null,
          input.location ?? null,
          input.interviewLanguage ?? 'zh',
          input.confidence ?? 1,
          input.userConfirmed === false ? 0 : 1,
        );
      raw
        .prepare(`UPDATE campaign SET role_profile_id = ? WHERE id = ?`)
        .run(roleProfileId, input.campaignId);
    }

    const previous = raw
      .prepare(
        `SELECT max(revision) AS revision FROM campaign_plugin_binding WHERE campaign_id = ?`,
      )
      .get(input.campaignId) as { revision: number | null };
    const revision = (previous.revision ?? 0) + 1;

    // 旧 revision 只停用执行，不删除：历史结果必须继续可解释。
    raw
      .prepare(`UPDATE campaign_plugin_binding SET active_execution = 0 WHERE campaign_id = ?`)
      .run(input.campaignId);

    const insertBinding = raw.prepare(
      `INSERT INTO campaign_plugin_binding (
         id, campaign_id, plugin_id, plugin_version, config_json,
         config_snapshot_hash, revision, active_execution, enabled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const bound: ResolvedPluginRef[] = [
      snapshot.rolePack,
      ...(snapshot.industryPack ? [snapshot.industryPack] : []),
      ...snapshot.capabilities.filter(
        (item): item is ResolvedPluginRef & { enabled: true } => item.enabled,
      ),
    ];
    bound.forEach((plugin) => {
      insertBinding.run(
        randomUUID(),
        input.campaignId,
        plugin.id,
        plugin.version,
        JSON.stringify({ source: 'role-profile' }),
        snapshot.configSnapshotHash,
        revision,
        timestamp,
      );
    });

    raw
      .prepare(
        `INSERT INTO campaign_runtime_descriptor (
           id, campaign_id, revision, core_version, role_pack, industry_pack,
           capabilities, competency_baseline_version, config_snapshot_hash, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.campaignId,
        revision,
        snapshot.coreVersion,
        JSON.stringify(snapshot.rolePack),
        snapshot.industryPack ? JSON.stringify(snapshot.industryPack) : null,
        JSON.stringify(snapshot.capabilities),
        snapshot.competencyBaselineVersion,
        snapshot.configSnapshotHash,
        timestamp,
      );
  });

  activate();

  const view = readDescriptor(raw, input.campaignId);
  if (!view) throw new Error(`Runtime descriptor 写入后不可读：${input.campaignId}`);
  return view;
}

/**
 * 纯视图计算：只读 descriptor 与调用方的本机安装清单，绝不回写绑定。
 */
export function getClientCapabilityView(
  raw: Database,
  request: ClientCapabilityViewRequest,
): ClientCapabilityView | null {
  const runtime = readDescriptor(raw, request.campaignId);
  if (!runtime) return null;
  return buildClientCapabilityView({
    descriptor: runtime.descriptor,
    platform: request.platform,
    // 调用方没给就用本机真实安装集合。原来兜底到内置清单，在外置插件出现之后就是错的：
    // 手机端问过来时该由它自己给出本机集合，桌面替它答等于把桌面装的包算到手机头上
    installed: request.installed ?? listInstalledPlugins(),
    artifacts: request.artifacts,
  });
}
