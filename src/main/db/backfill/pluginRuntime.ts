import type { Database } from 'better-sqlite3';
import { LEGACY_CAMPAIGN_SCOPE_KIND } from '@shared/planner/contributions';
import { LEGACY_ROLE_PACK_REF } from '@shared/plugins/legacyRoleData';
import { hashRuntimeConfig } from '@shared/plugins/resolver';
import type { CampaignRuntimeDescriptor, ResolvedPluginRef } from '@shared/plugins/types';

// 回填、兜底描述符与旧数据投影共用同一个引用：三处各写一份字面量时，改错一处的表现是
// 旧战役的 config_snapshot_hash 跳变，而 hash 对不上会被当成「配置被人动过」
export const LEGACY_ROLE_PACK_ID = LEGACY_ROLE_PACK_REF.id;
export const LEGACY_ROLE_PACK_VERSION = LEGACY_ROLE_PACK_REF.version;
export const LEGACY_REPOSITORY_CAPABILITY_ID = 'source-repository';
export const LEGACY_REPOSITORY_CAPABILITY_VERSION = '1.0.0';
export const LEGACY_CORE_VERSION = '1.0.0';
export const LEGACY_SCHEMA_VERSION = 23;
export const PLUGIN_RUNTIME_BACKFILL_KIND = 'generic-interview-v1';

interface LegacyCampaign {
  id: string;
}

export interface PluginRuntimeBackfillFailure {
  campaignId: string;
  message: string;
}

export interface PluginRuntimeBackfillReport {
  completed: number;
  failures: PluginRuntimeBackfillFailure[];
}

export interface PluginRuntimeBackfillOptions {
  now?: () => number;
  /** 仅供事务回滚测试注入故障。 */
  beforeCheckpoint?: (campaignId: string) => void;
}

function stableId(kind: string, campaignId: string, suffix = ''): string {
  return `${PLUGIN_RUNTIME_BACKFILL_KIND}:${kind}:${campaignId}${suffix}`;
}

/**
 * 为旧 Campaign 建立首个插件 revision。
 *
 * 只处理带 `LEGACY_CAMPAIGN_SCOPE_KIND` 凭据的 Campaign——也就是插件化迁移那一刻
 * 就已经存在的那批。新建战役不在其中，它们停在「还没选岗位」的状态等用户自己挑，
 * 不会被冒充成工程岗。
 *
 * 每个 Campaign 独立事务：任何一步失败都不会留下 profile/binding/descriptor，
 * 也不会设置 role_profile_id；凭据还在，下次启动仍会选中并重试。
 */
export function backfillLegacyCampaignPluginRuntime(
  raw: Database,
  options: PluginRuntimeBackfillOptions = {},
): PluginRuntimeBackfillReport {
  const rows = raw
    .prepare(
      `SELECT c.id
       FROM campaign c
       JOIN migration_checkpoint legacy
         ON legacy.campaign_id = c.id AND legacy.kind = ?
       WHERE c.role_profile_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM migration_checkpoint m
           WHERE m.campaign_id = c.id AND m.kind = ?
         )
       ORDER BY c.id`,
    )
    .all(LEGACY_CAMPAIGN_SCOPE_KIND, PLUGIN_RUNTIME_BACKFILL_KIND) as LegacyCampaign[];

  const report: PluginRuntimeBackfillReport = { completed: 0, failures: [] };
  const migrateOne = raw.transaction((campaign: LegacyCampaign) => {
    const timestamp = options.now?.() ?? Date.now();
    const revision = 1;
    const rolePack: ResolvedPluginRef = {
      id: LEGACY_ROLE_PACK_ID,
      version: LEGACY_ROLE_PACK_VERSION,
    };
    const capabilities: CampaignRuntimeDescriptor['capabilities'] = [
      {
        id: LEGACY_REPOSITORY_CAPABILITY_ID,
        version: LEGACY_REPOSITORY_CAPABILITY_VERSION,
        enabled: true,
      },
    ];
    const hashInput = {
      coreVersion: LEGACY_CORE_VERSION,
      schemaVersion: LEGACY_SCHEMA_VERSION,
      rolePack,
      industryPack: undefined,
      capabilities,
      competencyBaselineVersion: LEGACY_ROLE_PACK_VERSION,
    };
    const configSnapshotHash = hashRuntimeConfig(hashInput);
    const descriptor: CampaignRuntimeDescriptor = {
      campaignId: campaign.id,
      coreVersion: LEGACY_CORE_VERSION,
      rolePack,
      capabilities,
      competencyBaselineVersion: LEGACY_ROLE_PACK_VERSION,
      configSnapshotHash,
      resolvedAt: timestamp,
    };

    raw
      .prepare(
        `INSERT INTO role_profile (
           id, role_family, role_pack_id, level, industry_pack_id, location,
           interview_language, confidence, user_confirmed
         ) VALUES (?, ?, ?, NULL, NULL, NULL, 'zh', 1, 0)`,
      )
      .run(
        stableId('role-profile', campaign.id),
        LEGACY_ROLE_PACK_ID,
        LEGACY_ROLE_PACK_ID,
      );

    const updated = raw
      .prepare(
        `UPDATE campaign SET role_profile_id = ?
         WHERE id = ? AND role_profile_id IS NULL`,
      )
      .run(stableId('role-profile', campaign.id), campaign.id);
    if (updated.changes !== 1) throw new Error('Campaign 已被并发迁移');

    const insertBinding = raw.prepare(
      `INSERT INTO campaign_plugin_binding (
         id, campaign_id, plugin_id, plugin_version, config_json,
         config_snapshot_hash, revision, active_execution, enabled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    for (const plugin of [
      { id: LEGACY_ROLE_PACK_ID, version: LEGACY_ROLE_PACK_VERSION },
      {
        id: LEGACY_REPOSITORY_CAPABILITY_ID,
        version: LEGACY_REPOSITORY_CAPABILITY_VERSION,
      },
    ]) {
      insertBinding.run(
        stableId('binding', campaign.id, `:${plugin.id}:${revision}`),
        campaign.id,
        plugin.id,
        plugin.version,
        JSON.stringify({ source: 'legacy-backfill' }),
        configSnapshotHash,
        revision,
        timestamp,
      );
    }

    raw
      .prepare(
        `INSERT INTO campaign_runtime_descriptor (
           id, campaign_id, revision, core_version, role_pack, industry_pack,
           capabilities, competency_baseline_version, config_snapshot_hash, resolved_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        stableId('descriptor', campaign.id, `:${revision}`),
        campaign.id,
        revision,
        descriptor.coreVersion,
        JSON.stringify(descriptor.rolePack),
        JSON.stringify(descriptor.capabilities),
        descriptor.competencyBaselineVersion,
        descriptor.configSnapshotHash,
        descriptor.resolvedAt,
      );

    options.beforeCheckpoint?.(campaign.id);

    raw
      .prepare(
        `INSERT INTO migration_checkpoint (id, campaign_id, kind, completed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        stableId('checkpoint', campaign.id),
        campaign.id,
        PLUGIN_RUNTIME_BACKFILL_KIND,
        timestamp,
      );
  });

  for (const campaign of rows) {
    try {
      migrateOne(campaign);
      report.completed += 1;
    } catch (error) {
      report.failures.push({
        campaignId: campaign.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
