/**
 * Phase 0 兼容性闸门（桌面旧库）。
 *
 * 回填本身的事务性和幂等性由 backfill/pluginRuntime.test.ts 覆盖，但那是从完整
 * schema 的空战役起步的。这里要回答另一个问题：一个插件化之前就带着知识树、
 * 计划和仓库的真实旧库，升级到插件 schema 之后还能不能原样用下去——旧数据一
 * 个字节都不该被重写，descriptor 要补得出来，而且补出来的 hash 必须和共享层
 * 排程用的那份一致。
 */
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { legacyRuntimeDescriptor } from '@shared/planner/contributions';
import {
  PHASE0_CAMPAIGN,
  PHASE0_NODES,
  PHASE0_PLAN_DAYS,
  PHASE0_READY_REPO_ID,
  PHASE0_REPOS,
  PHASE0_TASKS,
} from '@shared/plugins/__fixtures__/phase0Campaign';
import { EXAM_FORMS } from '@shared/enums';
import {
  applyMigrations,
  captureContents,
  captureShapes,
  newLegacyDb,
  type TableShapes,
} from './__fixtures__/legacyDb';
import { backfillLegacyCampaignPluginRuntime } from './backfill/pluginRuntime';

/** 插件运行时迁移之前的最后一条：旧库就停在这里。 */
const PRE_PLUGIN_MIGRATION = '0022_campaign_resume_backfill';
const PLUGIN_MIGRATION = '0023_plugin_runtime_persistence';

function seedLegacyCampaign(raw: Database): void {
  raw
    .prepare(
      `INSERT INTO campaign (
         id, company, role_title, jd_raw, interview_date, daily_minutes,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      PHASE0_CAMPAIGN.id,
      PHASE0_CAMPAIGN.company,
      PHASE0_CAMPAIGN.roleTitle,
      PHASE0_CAMPAIGN.jdRaw,
      PHASE0_CAMPAIGN.interviewDate,
      PHASE0_CAMPAIGN.dailyMinutes,
      PHASE0_CAMPAIGN.status,
      PHASE0_CAMPAIGN.createdAt,
      PHASE0_CAMPAIGN.updatedAt,
    );

  const insertNode = raw.prepare(
    `INSERT INTO knowledge_node (
       id, campaign_id, parent_id, name, kind, coverage_type,
       difficulty, est_minutes, exam_forms, priority_score, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  PHASE0_NODES.forEach((node) => {
    insertNode.run(
      node.id,
      PHASE0_CAMPAIGN.id,
      node.parentId,
      node.name,
      node.kind,
      node.coverageType,
      node.difficulty,
      node.estMinutes,
      JSON.stringify(node.examForms),
      node.priorityScore,
      PHASE0_CAMPAIGN.createdAt,
    );
  });

  const insertRepo = raw.prepare(
    `INSERT INTO repo (id, url, local_path, status) VALUES (?, ?, ?, ?)`,
  );
  PHASE0_REPOS.forEach((repo) => {
    insertRepo.run(repo.id, repo.url, repo.localPath, repo.status);
  });

  const insertDay = raw.prepare(
    `INSERT INTO plan_day (id, campaign_id, date, planned_minutes, status)
     VALUES (?, ?, ?, ?, ?)`,
  );
  PHASE0_PLAN_DAYS.forEach((day) => {
    insertDay.run(day.id, PHASE0_CAMPAIGN.id, day.date, day.plannedMinutes, day.status);
  });

  const insertTask = raw.prepare(
    `INSERT INTO task (id, plan_day_id, node_id, repo_id, kind, est_minutes, status, order_idx)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  PHASE0_TASKS.forEach((task) => {
    insertTask.run(
      task.id,
      task.planDayId,
      task.nodeId,
      task.repoId,
      task.kind,
      task.estMinutes,
      task.status,
      task.orderIdx,
    );
  });
}

function one<T>(raw: Database, sql: string, ...args: unknown[]): T {
  const row = raw.prepare(sql).get(...args);
  if (!row) throw new Error(`没有查到行：${sql}`);
  return row as T;
}

describe('Phase 0 旧库兼容性', () => {
  let raw: Database;
  let legacyShapes: TableShapes;

  beforeEach(() => {
    raw = newLegacyDb({ through: PRE_PLUGIN_MIGRATION });
    seedLegacyCampaign(raw);
    legacyShapes = captureShapes(raw);
  });

  it('旧库停在插件化之前，本来就没有插件运行时的表和列', () => {
    expect(Object.keys(legacyShapes)).not.toContain('campaign_runtime_descriptor');
    expect(legacyShapes.campaign).not.toContain('role_profile_id');
  });

  it('升级并回填之后旧数据一个字节都没被重写', () => {
    const before = captureContents(raw, legacyShapes);

    applyMigrations(raw, { after: PRE_PLUGIN_MIGRATION });
    expect(backfillLegacyCampaignPluginRuntime(raw, { now: () => 1_700_000_001_000 })).toEqual({
      completed: 1,
      failures: [],
    });

    // 只比较旧列：新增列不算旧数据被改动，要盯的是旧列的值有没有被悄悄重写
    expect(captureContents(raw, legacyShapes)).toEqual(before);
  });

  it('回填只在 campaign 上补一个 role_profile_id', () => {
    applyMigrations(raw, { after: PRE_PLUGIN_MIGRATION });
    backfillLegacyCampaignPluginRuntime(raw);

    const campaign = one<{ role_profile_id: string | null }>(
      raw,
      `SELECT role_profile_id FROM campaign WHERE id = ?`,
      PHASE0_CAMPAIGN.id,
    );
    expect(campaign.role_profile_id).not.toBeNull();

    const profile = one<{ role_pack_id: string; user_confirmed: number }>(
      raw,
      `SELECT role_pack_id, user_confirmed FROM role_profile WHERE id = ?`,
      campaign.role_profile_id,
    );
    // 回填是系统推断的，不能冒充用户已确认
    expect(profile).toEqual({ role_pack_id: 'software-engineering', user_confirmed: 0 });
  });

  it('回填出的 descriptor hash 与共享层排程用的那份一致', () => {
    applyMigrations(raw, { after: PRE_PLUGIN_MIGRATION });
    backfillLegacyCampaignPluginRuntime(raw);

    const stored = one<{ config_snapshot_hash: string; revision: number }>(
      raw,
      `SELECT config_snapshot_hash, revision FROM campaign_runtime_descriptor
       WHERE campaign_id = ?`,
      PHASE0_CAMPAIGN.id,
    );

    expect(stored.revision).toBe(1);
    // 桌面回填和共享层的兜底 descriptor 各自硬编码了一套 legacy 常量。回填前后
    // 排程结果不许跳变，所以这两套常量算出的 hash 必须相等——这里是唯一会在它们
    // 漂移时失败的地方。
    expect(stored.config_snapshot_hash).toBe(
      legacyRuntimeDescriptor(PHASE0_CAMPAIGN.id).configSnapshotHash,
    );
  });

  it('升级不影响四种题型的考点和已排好的 readCode', () => {
    applyMigrations(raw, { after: PRE_PLUGIN_MIGRATION });
    backfillLegacyCampaignPluginRuntime(raw);

    const examForms = new Set(
      (
        raw
          .prepare(`SELECT exam_forms FROM knowledge_node WHERE campaign_id = ?`)
          .all(PHASE0_CAMPAIGN.id) as Array<{ exam_forms: string }>
      ).flatMap((row) => JSON.parse(row.exam_forms) as string[]),
    );
    expect([...examForms].sort()).toEqual([...EXAM_FORMS].sort());

    const readCode = one<{ repo_id: string; est_minutes: number; status: string }>(
      raw,
      `SELECT t.repo_id, t.est_minutes, r.status
       FROM task t JOIN repo r ON r.id = t.repo_id
       WHERE t.kind = 'readCode'`,
    );
    expect(readCode).toEqual({
      repo_id: PHASE0_READY_REPO_ID,
      est_minutes: 25,
      status: 'ready',
    });
  });

  it('插件迁移紧跟在旧库最后一条之后，中间没有断档', () => {
    expect(applyMigrations(raw, { after: PRE_PLUGIN_MIGRATION })[0]).toBe(PLUGIN_MIGRATION);
  });
});
