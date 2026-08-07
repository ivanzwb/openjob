import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DateOnly } from '@shared/entities';
import type { PlanGenerateResult, TaskView, TodayCampaignOption, TodayPlan } from '@shared/ipc';
import type { TaskKind } from '@shared/enums';
import { getDb, schema } from '../db';
import { getCampaignRow, listCampaigns, rowToNode, updateCampaign } from '../campaign/repository';

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

/** 刻意保守：只排可用时长的 85%，制造完成感 */
function dailyBudget(minutes: number): number {
  return Math.floor(minutes * 0.85);
}

/** 预估学习时长再打折，避免第一天就排爆 */
function conservativeEst(minutes: number): number {
  return Math.max(10, Math.ceil(minutes * 0.75));
}

export function generatePlan(
  campaignId: string,
  interviewDate?: string | null,
  dailyMinutes?: number | null,
): PlanGenerateResult {
  const campaign = getCampaignRow(campaignId);
  const endDate = interviewDate ?? campaign.interviewDate ?? addDays(formatLocal(new Date()), 13);
  const daily = dailyMinutes ?? campaign.dailyMinutes ?? 90;

  const db = getDb();
  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all()
    .map(rowToNode)
  // domain 是容器，不直接排进日程
    .filter((n) => n.kind !== 'domain')
    .sort((a, b) => b.priorityScore - a.priorityScore);

  if (nodes.length === 0) throw new Error('没有可排期的考点，请先完成 JD 诊断');

  // 清空旧计划
  const oldDays = db
    .select()
    .from(schema.planDay)
    .where(eq(schema.planDay.campaignId, campaignId))
    .all();
  if (oldDays.length) {
    db.delete(schema.task)
      .where(
        inArray(
          schema.task.planDayId,
          oldDays.map((d) => d.id),
        ),
      )
      .run();
    db.delete(schema.planDay).where(eq(schema.planDay.campaignId, campaignId)).run();
  }

  const today = formatLocal(new Date());
  const dates = daysBetween(today, endDate);
  if (dates.length === 0) throw new Error('面试日期必须不早于今天');

  updateCampaign({
    id: campaignId,
    interviewDate: endDate,
    dailyMinutes: daily,
    status: 'active',
  });

  let nodeIdx = 0;
  let tasksCreated = 0;
  let overflowFallbacks = 0;
  const learnedQueue: string[] = [];

  const readyRepos = getDb()
    .select()
    .from(schema.repo)
    .all()
    .filter((r) => r.status === 'ready');
  const defaultRepoId = readyRepos[0]?.id ?? null;

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]!;
    const planDayId = randomUUID();
    const budget = dailyBudget(daily);
    let used = 0;
    const dayTasks: Array<{
      kind: TaskKind;
      nodeId: string | null;
      repoId: string | null;
      estMinutes: number;
      orderIdx: number;
    }> = [];

    // 昨天新学的，今天安排 drill
    if (di > 0 && learnedQueue.length > 0) {
      const drillId = learnedQueue.shift()!;
      const node = nodes.find((n) => n.id === drillId);
      if (node) {
        const est = Math.min(15, conservativeEst(node.estMinutes));
        if (used + est <= budget) {
          dayTasks.push({
            kind: 'drill',
            nodeId: drillId,
            repoId: null,
            estMinutes: est,
            orderIdx: dayTasks.length,
          });
          used += est;
        }
      }
    }

    // 每天 2-3 个新学任务
    const learnTarget = di === dates.length - 1 ? 1 : 3;
    for (let i = 0; i < learnTarget && nodeIdx < nodes.length; i++) {
      const node = nodes[nodeIdx++]!;
      const est = conservativeEst(node.estMinutes);
      if (used + est > budget) {
        nodeIdx--;
        break;
      }
      dayTasks.push({
        kind: 'learn',
        nodeId: node.id,
        repoId: null,
        estMinutes: est,
        orderIdx: dayTasks.length,
      });
      used += est;
      learnedQueue.push(node.id);
    }

    // 掌握度偏低的加 review
    const shaky = nodes.filter((n) => n.mastery > 0 && n.mastery < 3 && n.status !== 'mastered');
    for (const node of shaky.slice(0, 1)) {
      const est = 15;
      if (used + est <= budget) {
        dayTasks.push({
          kind: 'review',
          nodeId: node.id,
          repoId: null,
          estMinutes: est,
          orderIdx: dayTasks.length,
        });
        used += est;
      }
    }

    // 每隔一天安排源码阅读（有已索引仓库时）
    if (defaultRepoId && di % 2 === 1) {
      const est = 25;
      if (used + est <= budget) {
        dayTasks.push({
          kind: 'readCode',
          nodeId: null,
          repoId: defaultRepoId,
          estMinutes: est,
          orderIdx: dayTasks.length,
        });
        used += est;
      }
    }

    db.insert(schema.planDay)
      .values({
        id: planDayId,
        campaignId,
        date,
        plannedMinutes: used,
        status: 'pending',
      })
      .run();

    for (const t of dayTasks) {
      db.insert(schema.task)
        .values({
          id: randomUUID(),
          planDayId,
          nodeId: t.nodeId,
          repoId: t.repoId,
          kind: t.kind,
          estMinutes: t.estMinutes,
          actualMinutes: null,
          status: 'pending',
          orderIdx: t.orderIdx,
        })
        .run();
      tasksCreated++;
    }
  }

  // 排不下的高优先级考点 → 最后一天加兜底话术任务
  while (nodeIdx < nodes.length) {
    const node = nodes[nodeIdx++]!;
    const lastDay = dates[dates.length - 1]!;
    const planDay = db
      .select()
      .from(schema.planDay)
      .where(and(eq(schema.planDay.campaignId, campaignId), eq(schema.planDay.date, lastDay)))
      .get();
    if (!planDay) break;

    db.insert(schema.task)
      .values({
        id: randomUUID(),
        planDayId: planDay.id,
        nodeId: node.id,
        repoId: null,
        kind: 'fallbackScript',
        estMinutes: 10,
        actualMinutes: null,
        status: 'pending',
        orderIdx: 999,
      })
      .run();
    tasksCreated++;
    overflowFallbacks++;
  }

  return { daysCreated: dates.length, tasksCreated, overflowFallbacks };
}

export function listTodayCampaigns(): TodayCampaignOption[] {
  const db = getDb();
  const today = formatLocal(new Date());
  const campaigns = listCampaigns().filter((c) => c.status === 'active' || c.status === 'planning');

  return campaigns.map((c) => {
    const planDay = db
      .select()
      .from(schema.planDay)
      .where(and(eq(schema.planDay.campaignId, c.id), eq(schema.planDay.date, today)))
      .get();

    if (!planDay) {
      return {
        id: c.id,
        company: c.company,
        roleTitle: c.roleTitle,
        status: c.status,
        hasPlanToday: false,
        completedCount: 0,
        totalCount: 0,
      };
    }

    const tasks = db
      .select()
      .from(schema.task)
      .where(eq(schema.task.planDayId, planDay.id))
      .all();
    const completedCount = tasks.filter((t) => t.status === 'done').length;

    return {
      id: c.id,
      company: c.company,
      roleTitle: c.roleTitle,
      status: c.status,
      hasPlanToday: true,
      completedCount,
      totalCount: tasks.length,
    };
  });
}

function resolveCampaignId(campaignId?: string): string | null {
  if (campaignId) return campaignId;
  const db = getDb();
  const active = db
    .select()
    .from(schema.campaign)
    .where(eq(schema.campaign.status, 'active'))
    .all();
  if (active.length === 0) return null;
  return active.sort((a, b) => b.updatedAt - a.updatedAt)[0]!.id;
}

export function getTodayPlan(campaignId?: string): TodayPlan | null {
  const id = resolveCampaignId(campaignId);
  if (!id) return null;

  const campaign = getCampaignRow(id);
  const today = formatLocal(new Date());
  const db = getDb();

  const planDay = db
    .select()
    .from(schema.planDay)
    .where(and(eq(schema.planDay.campaignId, id), eq(schema.planDay.date, today)))
    .get();

  if (!planDay) {
    return {
      campaignId: id,
      company: campaign.company,
      roleTitle: campaign.roleTitle,
      date: today,
      planDay: null,
      tasks: [],
      completedCount: 0,
      totalCount: 0,
      plannedMinutes: 0,
    };
  }

  const taskRows = db
    .select()
    .from(schema.task)
    .where(eq(schema.task.planDayId, planDay.id))
    .all()
    .sort((a, b) => a.orderIdx - b.orderIdx);

  const nodeIds = taskRows.map((t) => t.nodeId).filter(Boolean) as string[];
  const repoIds = taskRows.map((t) => t.repoId).filter(Boolean) as string[];
  const nodeMap = new Map<string, { name: string; coverageType: TaskView['nodeCoverage'] }>();
  const repoMap = new Map<string, string>();
  if (nodeIds.length) {
    const nodeRows = db
      .select()
      .from(schema.knowledgeNode)
      .where(inArray(schema.knowledgeNode.id, nodeIds))
      .all();
    for (const n of nodeRows) {
      nodeMap.set(n.id, { name: n.name, coverageType: n.coverageType });
    }
  }
  if (repoIds.length) {
    const repoRows = db.select().from(schema.repo).where(inArray(schema.repo.id, repoIds)).all();
    for (const r of repoRows) {
      repoMap.set(r.id, r.url);
    }
  }

  const tasks: TaskView[] = taskRows.map((t) => {
    const node = t.nodeId ? nodeMap.get(t.nodeId) : null;
    return {
      id: t.id,
      planDayId: t.planDayId,
      nodeId: t.nodeId,
      repoId: t.repoId,
      kind: t.kind,
      estMinutes: t.estMinutes,
      actualMinutes: t.actualMinutes,
      status: t.status,
      orderIdx: t.orderIdx,
      nodeName: node?.name ?? null,
      nodeCoverage: node?.coverageType ?? null,
      repoUrl: t.repoId ? (repoMap.get(t.repoId) ?? null) : null,
    };
  });

  const completedCount = tasks.filter((t) => t.status === 'done').length;

  return {
    campaignId: id,
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    date: today,
    planDay: {
      id: planDay.id,
      campaignId: planDay.campaignId,
      date: planDay.date,
      plannedMinutes: planDay.plannedMinutes,
      status: planDay.status,
    },
    tasks,
    completedCount,
    totalCount: tasks.length,
    plannedMinutes: planDay.plannedMinutes,
  };
}

export function deferToday(campaignId: string): number {
  const today = formatLocal(new Date());
  const tomorrow = addDays(today, 1);
  const db = getDb();

  const planDay = db
    .select()
    .from(schema.planDay)
    .where(and(eq(schema.planDay.campaignId, campaignId), eq(schema.planDay.date, today)))
    .get();
  if (!planDay) return 0;

  let tomorrowDay = db
    .select()
    .from(schema.planDay)
    .where(and(eq(schema.planDay.campaignId, campaignId), eq(schema.planDay.date, tomorrow)))
    .get();

  if (!tomorrowDay) {
    const id = randomUUID();
    db.insert(schema.planDay)
      .values({
        id,
        campaignId,
        date: tomorrow,
        plannedMinutes: 0,
        status: 'pending',
      })
      .run();
    tomorrowDay = db.select().from(schema.planDay).where(eq(schema.planDay.id, id)).get()!;
  }

  const pending = db
    .select()
    .from(schema.task)
    .where(and(eq(schema.task.planDayId, planDay.id), eq(schema.task.status, 'pending')))
    .all();

  let deferred = 0;
  const maxOrder =
    db
      .select()
      .from(schema.task)
      .where(eq(schema.task.planDayId, tomorrowDay.id))
      .all()
      .reduce((m, t) => Math.max(m, t.orderIdx), -1) + 1;

  for (const t of pending) {
    db.update(schema.task).set({ status: 'skipped' }).where(eq(schema.task.id, t.id)).run();
    db.insert(schema.task)
      .values({
        id: randomUUID(),
        planDayId: tomorrowDay.id,
        nodeId: t.nodeId,
        repoId: t.repoId,
        kind: t.kind,
        estMinutes: t.estMinutes,
        actualMinutes: null,
        status: 'pending',
        orderIdx: maxOrder + deferred,
      })
      .run();
    deferred++;
  }

  if (deferred > 0) {
    db.update(schema.planDay)
      .set({ status: 'deferred' })
      .where(eq(schema.planDay.id, planDay.id))
      .run();
  }

  return deferred;
}

export function completeTask(taskId: string, actualMinutes?: number): TaskView {
  const db = getDb();
  const row = db.select().from(schema.task).where(eq(schema.task.id, taskId)).get();
  if (!row) throw new Error('任务不存在');

  db.update(schema.task)
    .set({
      status: 'done',
      actualMinutes: actualMinutes ?? row.estMinutes,
    })
    .where(eq(schema.task.id, taskId))
    .run();

  if (row.nodeId && row.kind === 'learn') {
    db.update(schema.knowledgeNode)
      .set({ status: 'learning' })
      .where(eq(schema.knowledgeNode.id, row.nodeId))
      .run();
  }

  const updated = db.select().from(schema.task).where(eq(schema.task.id, taskId)).get()!;
  const node = row.nodeId
    ? db.select().from(schema.knowledgeNode).where(eq(schema.knowledgeNode.id, row.nodeId)).get()
    : null;
  const repo = row.repoId
    ? db.select().from(schema.repo).where(eq(schema.repo.id, row.repoId)).get()
    : null;

  return {
    id: updated.id,
    planDayId: updated.planDayId,
    nodeId: updated.nodeId,
    repoId: updated.repoId,
    kind: updated.kind,
    estMinutes: updated.estMinutes,
    actualMinutes: updated.actualMinutes,
    status: updated.status,
    orderIdx: updated.orderIdx,
    nodeName: node?.name ?? null,
    nodeCoverage: node?.coverageType ?? null,
    repoUrl: repo?.url ?? null,
  };
}

export function skipTask(taskId: string): TaskView {
  const db = getDb();
  const row = db.select().from(schema.task).where(eq(schema.task.id, taskId)).get();
  if (!row) throw new Error('任务不存在');

  db.update(schema.task).set({ status: 'skipped' }).where(eq(schema.task.id, taskId)).run();

  const node = row.nodeId
    ? db.select().from(schema.knowledgeNode).where(eq(schema.knowledgeNode.id, row.nodeId)).get()
    : null;
  const repo = row.repoId
    ? db.select().from(schema.repo).where(eq(schema.repo.id, row.repoId)).get()
    : null;

  return {
    ...row,
    status: 'skipped',
    nodeName: node?.name ?? null,
    nodeCoverage: node?.coverageType ?? null,
    repoUrl: repo?.url ?? null,
  };
}
