import type { Database } from 'better-sqlite3';
import { PRE_PLUGIN_CAMPAIGN_SCOPE_KIND, descriptorFromRolePack } from '@core/planner/contributions';
import { CORE_VERSION, RUNTIME_SCHEMA_VERSION } from '../../plugins/runtime';
import { synthesizeSuiteFromRolePack } from '@core/plugins/capabilitySuite';
import type { RolePack } from '@core/plugins/types';

export const PLUGIN_RUNTIME_BACKFILL_KIND = 'generic-interview-v1';

interface PrePluginCampaign {
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
  /**
   * 回填所 pin 的岗位包：调用方从本机安装清单解析（软件工程包）。
   * 未安装时调用方应跳过本次回填（不写 checkpoint），装包后的下一次启动或安装
   * 事件会重试——「插件装上才有一模一样的功能」，而不是伪造一份指向不存在版本的 pin。
   */
  pack?: RolePack;
  /** 仅供事务回滚测试注入故障。 */
  beforeCheckpoint?: (campaignId: string) => void;
}

function stableId(kind: string, campaignId: string, suffix = ''): string {
  return `${PLUGIN_RUNTIME_BACKFILL_KIND}:${kind}:${campaignId}${suffix}`;
}

/**
 * 为旧 Campaign 建立首个插件 revision。
 *
 * 只处理带 `PRE_PLUGIN_CAMPAIGN_SCOPE_KIND` 凭据的 Campaign——也就是插件化迁移那一刻
 * 就已经存在的那批。新建战役不在其中，它们停在「还没选岗位」的状态等用户自己挑，
 * 不会被冒充成工程岗。
 *
 * 每个 Campaign 独立事务：任何一步失败都不会留下 profile/binding/descriptor，
 * 也不会设置 role_profile_id；凭据还在，下次启动仍会选中并重试。
 */
export function backfillPrePluginCampaignRuntime(
  raw: Database,
  options: PluginRuntimeBackfillOptions = {},
): PluginRuntimeBackfillReport {
  const rows = raw
    .prepare(
      `SELECT c.id
       FROM campaign c
       JOIN migration_checkpoint pre
         ON pre.campaign_id = c.id AND pre.kind = ?
       WHERE c.role_profile_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM migration_checkpoint m
           WHERE m.campaign_id = c.id AND m.kind = ?
         )
       ORDER BY c.id`,
    )
    .all(PRE_PLUGIN_CAMPAIGN_SCOPE_KIND, PLUGIN_RUNTIME_BACKFILL_KIND) as PrePluginCampaign[];

  const report: PluginRuntimeBackfillReport = { completed: 0, failures: [] };
  if (!options.pack) {
    // 未装岗位包：回填无从谈起（不写 checkpoint），装包后的下一次启动/安装事件重试
    return report;
  }
  const pack = options.pack;
  const migrateOne = raw.transaction((campaign: PrePluginCampaign) => {
    const timestamp = options.now?.() ?? Date.now();
    const revision = 1;
    // descriptor 从已安装岗位包解析：pin 的是真实存在的版本，插件装上即原功能
    const descriptor = descriptorFromRolePack(campaign.id, pack, {
      coreVersion: CORE_VERSION,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
    });
    const suite = synthesizeSuiteFromRolePack(pack);
    const capabilityRef = suite
      ? { id: suite.manifest.id, version: suite.manifest.version }
      : null;

    raw
      .prepare(
        `INSERT INTO role_profile (
           id, role_family, role_pack_id, level, industry_pack_id, location,
           interview_language, confidence, user_confirmed
         ) VALUES (?, ?, ?, NULL, NULL, NULL, 'zh', 1, 0)`,
      )
      .run(
        stableId('role-profile', campaign.id),
        pack.manifest.id,
        pack.manifest.id,
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
      { id: pack.manifest.id, version: pack.manifest.version },
      ...(capabilityRef ? [capabilityRef] : []),
    ]) {
      insertBinding.run(
        stableId('binding', campaign.id, `:${plugin.id}:${revision}`),
        campaign.id,
        plugin.id,
        plugin.version,
        JSON.stringify({ source: 'legacy-backfill' }),
        descriptor.configSnapshotHash,
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
