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
} from '@shared/ipc';
import { softwareEngineeringRolePack } from '@shared/plugins/builtin/softwareEngineering';
import { sourceRepositoryCapabilityPlugin } from '@shared/plugins/builtin/sourceRepository';
import {
  buildClientCapabilityView,
  listBuiltInPlugins,
  type ClientCapabilityView,
  type InstalledPlugin,
} from '@shared/plugins/clientView';
import { BuiltInPluginRegistry } from '@shared/plugins/registry';
import { DeterministicRuntimeResolver } from '@shared/plugins/resolver';
import type {
  CampaignRuntimeDescriptor,
  ResolvedCapabilityRef,
  ResolvedPluginRef,
} from '@shared/plugins/types';
import type { RoleProfile } from '@shared/entities';
import {
  LEGACY_CORE_VERSION,
  LEGACY_SCHEMA_VERSION,
} from '../db/backfill/pluginRuntime';

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

function createRegistry(): BuiltInPluginRegistry {
  const registry = new BuiltInPluginRegistry();
  registry.register(softwareEngineeringRolePack);
  registry.registerCapability(sourceRepositoryCapabilityPlugin);
  return registry;
}

const resolver = new DeterministicRuntimeResolver(createRegistry());

export function listInstalledPlugins(): InstalledPlugin[] {
  return listBuiltInPlugins();
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
    installed: request.installed ?? listBuiltInPlugins(),
    artifacts: request.artifacts,
  });
}
