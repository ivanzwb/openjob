import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DateOnly } from '@core/entities';
import type { PlanGenerateResult } from '@core/ipc';
import type { TaskKind } from '@core/enums';
import { sortNodesByStudyOrder } from '@core/campaign/studyOrder';
import {
  PRE_PLUGIN_CAMPAIGN_SCOPE_KIND,
  collectPlannerContributions,
  descriptorFromRolePack,
  materialsFromRows,
  pluginTaskClientView,
  taskPresentation,
  type PlannedTaskClientView,
  type PlannerMaterial,
} from '@core/planner/contributions';
import type {
  CampaignRuntimeDescriptor,
  ResolvedPluginRef,
  RolePack,
} from '@core/plugins/types';
import { getCampaign } from './campaignLocal';
import { installedPluginsForCampaign,
  getCachedRolePack,
  listCachedRolePacks,
} from './rolePackLocal';
import { updateCampaignFields } from './nodesLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

function formatLocal(d: Date): DateOnly {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(s: DateOnly): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

function addDays(s: DateOnly, n: number): DateOnly {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return formatLocal(d);
}

function daysBetween(start: DateOnly, end: DateOnly): DateOnly[] {
  const out: DateOnly[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function dailyBudget(minutes: number): number {
  return Math.floor(minutes * 0.85);
}

function conservativeEst(minutes: number): number {
  return Math.max(10, Math.ceil(minutes * 0.75));
}

/** 是否属于插件化迁移那一刻就已存在的那批 Campaign（凭据由 0025 打上） */
function isPrePluginScopedCampaign(db: SQLiteDatabase, campaignId: string): boolean {
  const row = db.getFirstSync<{ id: string }>(
    `SELECT id FROM migration_checkpoint WHERE campaign_id = ? AND kind = ?`,
    campaignId,
    PRE_PLUGIN_CAMPAIGN_SCOPE_KIND,
  );
  return row !== null && row !== undefined;
}

/**
 * 取当前激活的 revision，判定与桌面 `src/main/plan/schedule.ts` 同一套。
 *
 * 没有 descriptor 的两种情况必须分开：插件化之前就存在的旧 Campaign（带
 * `PRE_PLUGIN_CAMPAIGN_SCOPE_KIND` 凭据）在桌面回填并同步过来之前继续走工程岗位包
 * 默认值，两端排程结果不跳变；新建的、还没选岗位的战役返回 null，不排插件任务。
 */
function loadRuntimeDescriptor(
  db: SQLiteDatabase,
  campaignId: string,
): CampaignRuntimeDescriptor | null {
  const row = db.getFirstSync<{
    core_version: string;
    role_pack: string;
    industry_pack: string | null;
    capabilities: string;
    competency_baseline_version: string;
    config_snapshot_hash: string;
    resolved_at: number;
  }>(
    `SELECT core_version, role_pack, industry_pack, capabilities, competency_baseline_version,
            config_snapshot_hash, resolved_at
     FROM campaign_runtime_descriptor WHERE campaign_id = ? ORDER BY revision DESC LIMIT 1`,
    campaignId,
  );
  if (!row) {
    if (!isPrePluginScopedCampaign(db, campaignId)) return null;
    // 插件化之前的旧战役默认是软件工程战役；descriptor 从缓存岗位包构建
    const pack =
      listCachedRolePacks(db).find((item) => item.manifest.id === 'software-engineering') ?? null;
    return pack
      ? descriptorFromRolePack(campaignId, pack, {
          coreVersion: '1.0.0',
          schemaVersion: 24,
        })
      : null;
  }

  return {
    campaignId,
    coreVersion: row.core_version,
    rolePack: JSON.parse(row.role_pack) as ResolvedPluginRef,
    industryPack: row.industry_pack
      ? (JSON.parse(row.industry_pack) as ResolvedPluginRef)
      : undefined,
    capabilities: JSON.parse(row.capabilities) as CampaignRuntimeDescriptor['capabilities'],
    competencyBaselineVersion: row.competency_baseline_version,
    configSnapshotHash: row.config_snapshot_hash,
    resolvedAt: row.resolved_at,
  };
}

/**
 * 已落库的插件任务在手机端能否执行。
 *
 * 手机排的插件任务与桌面逐条相同，本机跑不动时给出「需桌面完成」，
 * 而不是把任务从计划里抹掉。
 */
export function pluginTaskSupport(
  db: SQLiteDatabase,
  campaignId: string,
  kind: string,
): PlannedTaskClientView | null {
  const runtime = loadRuntimeDescriptor(db, campaignId);
  return pluginTaskClientView(
    runtime,
    kind,
    'mobile',
    installedPluginsForCampaign(db),
    resolveCampaignRolePack(db, runtime),
  );
}

/** 任务名与任务页来自岗位包声明；手机端只读缓存里的岗位包，未缓存则回落考点视图。 */
export function taskPresentationForPlanDay(
  db: SQLiteDatabase,
  planDayId: string,
  kind: string,
): { kindLabel: string | null; pageId: string | null } {
  const day = db.getFirstSync<{ campaign_id: string }>(
    `SELECT campaign_id FROM plan_day WHERE id = ?`,
    planDayId,
  );
  if (!day) return { kindLabel: null, pageId: null };
  const runtime = loadRuntimeDescriptor(db, day.campaign_id);
  return taskPresentation(resolveCampaignRolePack(db, runtime), kind);
}


/**
 * Campaign 岗位包的本机缓存数据：先按 descriptor pin 的精确版本，取不到退回同 id
 * 最新缓存版本（排程反映「现在缓存着什么」）；都没有返回 null，只走基础任务。
 */
function resolveCampaignRolePack(
  db: SQLiteDatabase,
  runtime: CampaignRuntimeDescriptor | null,
): RolePack | null {
  if (!runtime) return null;
  const { id, version } = runtime.rolePack;
  return (
    getCachedRolePack(db, id, version) ?? listCachedRolePacks(db).find((pack) => pack.manifest.id === id) ?? null
  );
}

/**
 * 从岗位包自己声明的数据集合里读材料行（`plugin_data`），解析成排程认识的材料。
 *
 * 与桌面同一条规则：宿主不认识材料语义，按模板声明的 (materialKind, materialCollection)
 * 逐条取数，值一律当字符串交给共享的 materialsFromRows 解析，两端因此逐条对齐。
 */
function loadMaterials(db: SQLiteDatabase, rolePack: RolePack | null): PlannerMaterial[] {
  if (!rolePack) return [];
  const materials: PlannerMaterial[] = [];
  for (const template of rolePack.taskTemplates) {
    if (!template.materialKind || !template.materialCollection) continue;
    const rows = db.getAllSync<{ value_json: string | null }>(
      `SELECT value_json FROM plugin_data WHERE plugin_id = ? AND collection = ?`,
      rolePack.manifest.id,
      template.materialCollection,
    );
    materials.push(...materialsFromRows(template.materialKind, rows.map((row) => row.value_json)));
  }
  return materials;
}

/** 把任务挂的 material_id 还原成展示名；扫本包声明的全部集合，不按 kind 收窄。 */
function materialLabels(db: SQLiteDatabase, rolePack: RolePack | null): Map<string, string> {
  const labels = new Map<string, string>();
  if (!rolePack) return labels;
  for (const collection of rolePack.manifest.dataCollections ?? []) {
    const rows = db.getAllSync<{ value_json: string | null }>(
      `SELECT value_json FROM plugin_data WHERE plugin_id = ? AND collection = ?`,
      rolePack.manifest.id,
      collection.name,
    );
    for (const material of materialsFromRows('', rows.map((row) => row.value_json))) {
      labels.set(material.id, material.label);
    }
  }
  return labels;
}

/** 任务卡上的材料标签：从该任务所在计划日反查战役的岗位包，再按 material_id 取 label。 */
export function materialLabelForPlanDay(
  db: SQLiteDatabase,
  planDayId: string,
  materialId: string | null,
): string | null {
  if (!materialId) return null;
  const day = db.getFirstSync<{ campaign_id: string }>(
    `SELECT campaign_id FROM plan_day WHERE id = ?`,
    planDayId,
  );
  if (!day) return null;
  const runtime = loadRuntimeDescriptor(db, day.campaign_id);
  return materialLabels(db, resolveCampaignRolePack(db, runtime)).get(materialId) ?? null;
}

export async function generatePlan(
  db: SQLiteDatabase,
  campaignId: string,
  interviewDate?: string | null,
  dailyMinutes?: number | null,
): Promise<PlanGenerateResult> {
  const campaign = getCampaign(db, campaignId);
  const endDate = interviewDate ?? campaign.interviewDate ?? addDays(formatLocal(new Date()), 13);
  const daily = dailyMinutes ?? campaign.dailyMinutes ?? 90;

  const candidates = db
    .getAllSync<{
      id: string;
      kind: string;
      est_minutes: number;
      status: string;
      mastery: number;
      difficulty: number;
      priority_score: number;
    }>(`SELECT id, kind, est_minutes, status, mastery, difficulty, priority_score FROM knowledge_node WHERE campaign_id = ?`, campaignId)
    .filter((n) => n.kind !== 'domain')
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      estMinutes: n.est_minutes,
      status: n.status,
      mastery: n.mastery,
      difficulty: n.difficulty,
      priorityScore: n.priority_score,
    }));

  if (candidates.length === 0) throw new Error('没有可排期的考点，请先完成 JD 诊断');

  const nodeIds = candidates.map((n) => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const edges = db.getAllSync<{ from_node_id: string; to_node_id: string; relation: string }>(
    `SELECT from_node_id, to_node_id, relation FROM node_edge WHERE from_node_id IN (${placeholders})`,
    ...nodeIds,
  ).map((e) => ({
    fromNodeId: e.from_node_id,
    toNodeId: e.to_node_id,
    relation: e.relation as 'prerequisite' | 'related' | 'contrast',
  }));

  const nodes = sortNodesByStudyOrder(candidates, edges);
  const identity = await getDeviceIdentity(db);

  writingAs(db, identity.deviceId, () => {
    const oldDays = db.getAllSync<{ id: string }>(`SELECT id FROM plan_day WHERE campaign_id = ?`, campaignId);
    for (const day of oldDays) {
      db.runSync(`DELETE FROM task WHERE plan_day_id = ?`, day.id);
    }
    db.runSync(`DELETE FROM plan_day WHERE campaign_id = ?`, campaignId);
  });

  const today = formatLocal(new Date());
  const dates = daysBetween(today, endDate);
  if (dates.length === 0) throw new Error('面试日期必须不早于今天');

  updateCampaignFields(db, {
    id: campaignId,
    interviewDate: endDate,
    dailyMinutes: daily,
    status: 'active',
  });

  let nodeIdx = 0;
  let tasksCreated = 0;
  let overflowFallbacks = 0;
  const learnedQueue: string[] = [];

  const runtime = loadRuntimeDescriptor(db, campaignId);
  const materials = loadMaterials(db, resolveCampaignRolePack(db, runtime));

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]!;
    const planDayId = Crypto.randomUUID();
    const budget = dailyBudget(daily);
    let used = 0;
    const dayTasks: {
      /** 宿主种类或岗位包声明的种类，落库时原样写入 */
      kind: string;
      nodeId: string | null;
      materialKind: string | null;
      materialId: string | null;
      estMinutes: number;
      orderIdx: number;
    }[] = [];

    if (di > 0 && learnedQueue.length > 0) {
      const drillId = learnedQueue.shift()!;
      const node = nodes.find((n) => n.id === drillId);
      if (node) {
        const est = Math.min(15, conservativeEst(node.estMinutes));
        if (used + est <= budget) {
          dayTasks.push({ kind: 'drill', nodeId: drillId, materialKind: null, materialId: null, estMinutes: est, orderIdx: dayTasks.length });
          used += est;
        }
      }
    }

    const learnTarget = di === dates.length - 1 ? 1 : 3;
    for (let i = 0; i < learnTarget && nodeIdx < nodes.length; i++) {
      const node = nodes[nodeIdx++]!;
      const est = conservativeEst(node.estMinutes);
      if (used + est > budget) {
        nodeIdx--;
        break;
      }
      dayTasks.push({ kind: 'learn', nodeId: node.id, materialKind: null, materialId: null, estMinutes: est, orderIdx: dayTasks.length });
      used += est;
      learnedQueue.push(node.id);
    }

    const shaky = nodes.filter(
      (n) => n.status === 'shaky' || (n.mastery > 0 && n.mastery < 3 && n.status !== 'mastered'),
    );
    for (const node of shaky.slice(0, 1)) {
      const est = 15;
      if (used + est <= budget) {
        dayTasks.push({ kind: 'review', nodeId: node.id, materialKind: null, materialId: null, estMinutes: est, orderIdx: dayTasks.length });
        used += est;
      }
    }

    // 插件任务（源码阅读等）由共享 PlannerContribution 决定，两端不各自判断
    for (const planned of collectPlannerContributions(runtime, {
      platform: 'mobile',
      dayIndex: di,
      dayCount: dates.length,
      budgetMinutes: budget,
      usedMinutes: used,
      materials,
      installed: installedPluginsForCampaign(db),
      rolePack: resolveCampaignRolePack(db, runtime),
    })) {
      dayTasks.push({
        kind: planned.kind,
        nodeId: planned.nodeId,
        materialKind: planned.materialKind,
        materialId: planned.materialId,
        estMinutes: planned.estMinutes,
        orderIdx: dayTasks.length,
      });
      used += planned.estMinutes;
    }

    writingAs(db, identity.deviceId, () => {
      db.runSync(
        `INSERT INTO plan_day (id, campaign_id, date, planned_minutes, status) VALUES (?, ?, ?, ?, 'pending')`,
        planDayId,
        campaignId,
        date,
        used,
      );
      for (const t of dayTasks) {
        db.runSync(
          `INSERT INTO task (id, plan_day_id, node_id, material_kind, material_id, kind, est_minutes, actual_minutes, status, order_idx)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
          Crypto.randomUUID(),
          planDayId,
          t.nodeId,
          t.materialKind,
          t.materialId,
          t.kind,
          t.estMinutes,
          t.orderIdx,
        );
        tasksCreated++;
      }
    });
  }

  while (nodeIdx < nodes.length) {
    const node = nodes[nodeIdx++]!;
    const lastDay = dates[dates.length - 1]!;
    const planDay = db.getFirstSync<{ id: string }>(
      `SELECT id FROM plan_day WHERE campaign_id = ? AND date = ?`,
      campaignId,
      lastDay,
    );
    if (!planDay) break;
    writingAs(db, identity.deviceId, () => {
      db.runSync(
        `INSERT INTO task (id, plan_day_id, node_id, material_kind, material_id, kind, est_minutes, actual_minutes, status, order_idx)
         VALUES (?, ?, ?, NULL, NULL, 'fallbackScript', 10, NULL, 'pending', 999)`,
        Crypto.randomUUID(),
        planDay.id,
        node.id,
      );
    });
    tasksCreated++;
    overflowFallbacks++;
  }

  return { daysCreated: dates.length, tasksCreated, overflowFallbacks };
}

export async function deferToday(db: SQLiteDatabase, campaignId: string): Promise<number> {
  const today = formatLocal(new Date());
  const tomorrow = addDays(today, 1);

  const planDay = db.getFirstSync<{ id: string }>(
    `SELECT id FROM plan_day WHERE campaign_id = ? AND date = ?`,
    campaignId,
    today,
  );
  if (!planDay) return 0;

  let tomorrowDay = db.getFirstSync<{ id: string }>(
    `SELECT id FROM plan_day WHERE campaign_id = ? AND date = ?`,
    campaignId,
    tomorrow,
  );

  const identity = await getDeviceIdentity(db);
  if (!tomorrowDay) {
    const id = Crypto.randomUUID();
    writingAs(db, identity.deviceId, () => {
      db.runSync(
        `INSERT INTO plan_day (id, campaign_id, date, planned_minutes, status) VALUES (?, ?, ?, 0, 'pending')`,
        id,
        campaignId,
        tomorrow,
      );
    });
    tomorrowDay = { id };
  }

  const pending = db.getAllSync<{
    id: string;
    node_id: string | null;
    material_kind: string | null;
    material_id: string | null;
    kind: string;
    est_minutes: number;
  }>(`SELECT id, node_id, material_kind, material_id, kind, est_minutes FROM task WHERE plan_day_id = ? AND status = 'pending'`, planDay.id);

  let deferred = 0;
  const maxOrder =
    (db.getFirstSync<{ m: number }>(`SELECT coalesce(max(order_idx), -1) AS m FROM task WHERE plan_day_id = ?`, tomorrowDay.id)?.m ?? -1) + 1;

  writingAs(db, identity.deviceId, () => {
    for (const t of pending) {
      db.runSync(`UPDATE task SET status = 'skipped' WHERE id = ?`, t.id);
      db.runSync(
        `INSERT INTO task (id, plan_day_id, node_id, material_kind, material_id, kind, est_minutes, actual_minutes, status, order_idx)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
        Crypto.randomUUID(),
        tomorrowDay!.id,
        t.node_id,
        t.material_kind,
        t.material_id,
        t.kind,
        t.est_minutes,
        maxOrder + deferred,
      );
      deferred++;
    }
    if (deferred > 0) {
      db.runSync(`UPDATE plan_day SET status = 'deferred' WHERE id = ?`, planDay.id);
    }
  });

  return deferred;
}
