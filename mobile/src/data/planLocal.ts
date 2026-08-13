import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DateOnly } from '@shared/entities';
import type { PlanGenerateResult } from '@shared/ipc';
import type { TaskKind } from '@shared/enums';
import { sortNodesByStudyOrder } from '@shared/campaign/studyOrder';
import { getCampaign } from './campaignLocal';
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

  const defaultRepoId =
    db.getFirstSync<{ id: string }>(`SELECT id FROM repo WHERE status = 'ready' ORDER BY url LIMIT 1`)?.id ??
    null;

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]!;
    const planDayId = Crypto.randomUUID();
    const budget = dailyBudget(daily);
    let used = 0;
    const dayTasks: {
      kind: TaskKind;
      nodeId: string | null;
      repoId: string | null;
      estMinutes: number;
      orderIdx: number;
    }[] = [];

    if (di > 0 && learnedQueue.length > 0) {
      const drillId = learnedQueue.shift()!;
      const node = nodes.find((n) => n.id === drillId);
      if (node) {
        const est = Math.min(15, conservativeEst(node.estMinutes));
        if (used + est <= budget) {
          dayTasks.push({ kind: 'drill', nodeId: drillId, repoId: null, estMinutes: est, orderIdx: dayTasks.length });
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
      dayTasks.push({ kind: 'learn', nodeId: node.id, repoId: null, estMinutes: est, orderIdx: dayTasks.length });
      used += est;
      learnedQueue.push(node.id);
    }

    const shaky = nodes.filter(
      (n) => n.status === 'shaky' || (n.mastery > 0 && n.mastery < 3 && n.status !== 'mastered'),
    );
    for (const node of shaky.slice(0, 1)) {
      const est = 15;
      if (used + est <= budget) {
        dayTasks.push({ kind: 'review', nodeId: node.id, repoId: null, estMinutes: est, orderIdx: dayTasks.length });
        used += est;
      }
    }

    if (defaultRepoId && di % 2 === 1) {
      const est = 25;
      if (used + est <= budget) {
        dayTasks.push({ kind: 'readCode', nodeId: null, repoId: defaultRepoId, estMinutes: est, orderIdx: dayTasks.length });
        used += est;
      }
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
          `INSERT INTO task (id, plan_day_id, node_id, repo_id, kind, est_minutes, actual_minutes, status, order_idx)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
          Crypto.randomUUID(),
          planDayId,
          t.nodeId,
          t.repoId,
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
        `INSERT INTO task (id, plan_day_id, node_id, repo_id, kind, est_minutes, actual_minutes, status, order_idx)
         VALUES (?, ?, ?, NULL, 'fallbackScript', 10, NULL, 'pending', 999)`,
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
    repo_id: string | null;
    kind: string;
    est_minutes: number;
  }>(`SELECT id, node_id, repo_id, kind, est_minutes FROM task WHERE plan_day_id = ? AND status = 'pending'`, planDay.id);

  let deferred = 0;
  const maxOrder =
    (db.getFirstSync<{ m: number }>(`SELECT coalesce(max(order_idx), -1) AS m FROM task WHERE plan_day_id = ?`, tomorrowDay.id)?.m ?? -1) + 1;

  writingAs(db, identity.deviceId, () => {
    for (const t of pending) {
      db.runSync(`UPDATE task SET status = 'skipped' WHERE id = ?`, t.id);
      db.runSync(
        `INSERT INTO task (id, plan_day_id, node_id, repo_id, kind, est_minutes, actual_minutes, status, order_idx)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
        Crypto.randomUUID(),
        tomorrowDay!.id,
        t.node_id,
        t.repo_id,
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
