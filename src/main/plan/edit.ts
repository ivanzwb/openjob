import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DateOnly } from '@shared/entities';
import type { TaskKind } from '@shared/enums';
import { getDb, schema } from '../db';

/**
 * 计划的手动调整。
 *
 * 自动排期给的是起点不是终点——用户比算法更清楚哪天有会、哪天状态好。
 * 拒绝调整只会让人干脆不看计划。
 */

function taskRow(taskId: string): typeof schema.task.$inferSelect {
  const row = getDb().select().from(schema.task).where(eq(schema.task.id, taskId)).get();
  if (!row) throw new Error('任务不存在');
  return row;
}

function recomputePlannedMinutes(planDayId: string): void {
  const db = getDb();
  const total = db
    .select()
    .from(schema.task)
    .where(eq(schema.task.planDayId, planDayId))
    .all()
    .reduce((sum, t) => sum + t.estMinutes, 0);
  db.update(schema.planDay)
    .set({ plannedMinutes: total })
    .where(eq(schema.planDay.id, planDayId))
    .run();
}

/** 按传入的 id 顺序重写 orderIdx */
export function reorderTasks(planDayId: string, taskIds: string[]): void {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.task)
    .where(eq(schema.task.planDayId, planDayId))
    .all();
  const known = new Set(existing.map((t) => t.id));

  let idx = 0;
  for (const id of taskIds) {
    if (!known.has(id)) continue;
    db.update(schema.task).set({ orderIdx: idx++ }).where(eq(schema.task.id, id)).run();
  }
  // 没出现在列表里的排到后面，避免顺序塌成同一个值
  for (const t of existing) {
    if (taskIds.includes(t.id)) continue;
    db.update(schema.task).set({ orderIdx: idx++ }).where(eq(schema.task.id, t.id)).run();
  }
}

function ensurePlanDay(campaignId: string, date: DateOnly): string {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.planDay)
    .where(and(eq(schema.planDay.campaignId, campaignId), eq(schema.planDay.date, date)))
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  db.insert(schema.planDay)
    .values({ id, campaignId, date, plannedMinutes: 0, status: 'pending' })
    .run();
  return id;
}

/** 改期：把任务挪到另一天，目标日没有 planDay 就建一个 */
export function moveTaskToDate(taskId: string, date: DateOnly): void {
  const db = getDb();
  const task = taskRow(taskId);
  const from = db
    .select()
    .from(schema.planDay)
    .where(eq(schema.planDay.id, task.planDayId))
    .get();
  if (!from) throw new Error('原计划日不存在');
  if (from.date === date) return;

  const toId = ensurePlanDay(from.campaignId, date);
  const tail = db
    .select()
    .from(schema.task)
    .where(eq(schema.task.planDayId, toId))
    .all().length;

  db.update(schema.task)
    .set({ planDayId: toId, orderIdx: tail })
    .where(eq(schema.task.id, taskId))
    .run();

  recomputePlannedMinutes(from.id);
  recomputePlannedMinutes(toId);
}

export function deleteTask(taskId: string): void {
  const db = getDb();
  const task = taskRow(taskId);
  db.delete(schema.task).where(eq(schema.task.id, taskId)).run();
  recomputePlannedMinutes(task.planDayId);
}

export interface AddTaskInput {
  campaignId: string;
  date: DateOnly;
  kind: TaskKind;
  nodeId?: string | null;
  repoId?: string | null;
  estMinutes?: number;
}

export function addTask(input: AddTaskInput): string {
  const db = getDb();
  const planDayId = ensurePlanDay(input.campaignId, input.date);
  const tail = db
    .select()
    .from(schema.task)
    .where(eq(schema.task.planDayId, planDayId))
    .all().length;

  const id = randomUUID();
  db.insert(schema.task)
    .values({
      id,
      planDayId,
      nodeId: input.nodeId ?? null,
      repoId: input.repoId ?? null,
      kind: input.kind,
      estMinutes: input.estMinutes ?? 20,
      actualMinutes: null,
      status: 'pending',
      orderIdx: tail,
    })
    .run();

  recomputePlannedMinutes(planDayId);
  return id;
}

export function updateTaskMinutes(taskId: string, estMinutes: number): void {
  const db = getDb();
  const task = taskRow(taskId);
  const minutes = Math.max(5, Math.min(240, Math.round(estMinutes)));
  db.update(schema.task).set({ estMinutes: minutes }).where(eq(schema.task.id, taskId)).run();
  recomputePlannedMinutes(task.planDayId);
}

/** 可作为改期目标的日期：今天起到面试日之间已存在或可新建的计划日 */
export function listPlanDates(campaignId: string): Array<{ date: DateOnly; taskCount: number }> {
  const db = getDb();
  const days = db
    .select()
    .from(schema.planDay)
    .where(eq(schema.planDay.campaignId, campaignId))
    .all()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return [];

  const counts = new Map<string, number>();
  for (const t of db
    .select()
    .from(schema.task)
    .where(
      inArray(
        schema.task.planDayId,
        days.map((d) => d.id),
      ),
    )
    .all()) {
    counts.set(t.planDayId, (counts.get(t.planDayId) ?? 0) + 1);
  }

  return days.map((d) => ({ date: d.date, taskCount: counts.get(d.id) ?? 0 }));
}
