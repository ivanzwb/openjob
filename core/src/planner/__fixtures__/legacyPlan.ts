/**
 * T07 之前桌面和手机各自维护的那份排程算法，逐行照搬为纯函数，作为「节奏不变」的
 * 判据：两端改用共享 PlannerContribution 之后排出的计划必须与这里逐条相同。
 *
 * 只有测试引用本文件。
 */
import type { DateOnly } from '../../entities';
import type { TaskKind } from '../../enums';

export interface LegacyPlanNode {
  id: string;
  estMinutes: number;
  status: string;
  mastery: number;
}

export interface LegacyPlanTask {
  kind: TaskKind;
  nodeId: string | null;
  repoId: string | null;
  estMinutes: number;
  orderIdx: number;
}

export interface LegacyPlanDay {
  dayIndex: number;
  date: DateOnly;
  /** 插件任务之前已占用的分钟数，插件贡献者按它判断预算 */
  baseMinutes: number;
  plannedMinutes: number;
  tasks: LegacyPlanTask[];
}

export interface LegacyPlanInput {
  today: DateOnly;
  interviewDate: DateOnly;
  dailyMinutes: number;
  /** 已按备考顺序排好的考点 */
  nodes: LegacyPlanNode[];
  defaultRepoId: string | null;
}

function parseDate(value: DateOnly): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

function formatLocal(value: Date): DateOnly {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(value: DateOnly, count: number): DateOnly {
  const date = parseDate(value);
  date.setDate(date.getDate() + count);
  return formatLocal(date);
}

export function daysBetween(start: DateOnly, end: DateOnly): DateOnly[] {
  const out: DateOnly[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function dailyBudget(minutes: number): number {
  return Math.floor(minutes * 0.85);
}

export function conservativeEst(minutes: number): number {
  return Math.max(10, Math.ceil(minutes * 0.75));
}

export function legacyPlan(input: LegacyPlanInput): LegacyPlanDay[] {
  const dates = daysBetween(input.today, input.interviewDate);
  const nodes = input.nodes;
  const days: LegacyPlanDay[] = [];
  const learnedQueue: string[] = [];
  let nodeIdx = 0;

  for (let di = 0; di < dates.length; di += 1) {
    const budget = dailyBudget(input.dailyMinutes);
    let used = 0;
    const tasks: LegacyPlanTask[] = [];

    if (di > 0 && learnedQueue.length > 0) {
      const drillId = learnedQueue.shift()!;
      const node = nodes.find((n) => n.id === drillId);
      if (node) {
        const est = Math.min(15, conservativeEst(node.estMinutes));
        if (used + est <= budget) {
          tasks.push({
            kind: 'drill',
            nodeId: drillId,
            repoId: null,
            estMinutes: est,
            orderIdx: tasks.length,
          });
          used += est;
        }
      }
    }

    const learnTarget = di === dates.length - 1 ? 1 : 3;
    for (let i = 0; i < learnTarget && nodeIdx < nodes.length; i += 1) {
      const node = nodes[nodeIdx]!;
      nodeIdx += 1;
      const est = conservativeEst(node.estMinutes);
      if (used + est > budget) {
        nodeIdx -= 1;
        break;
      }
      tasks.push({
        kind: 'learn',
        nodeId: node.id,
        repoId: null,
        estMinutes: est,
        orderIdx: tasks.length,
      });
      used += est;
      learnedQueue.push(node.id);
    }

    const shaky = nodes.filter(
      (n) => n.status === 'shaky' || (n.mastery > 0 && n.mastery < 3 && n.status !== 'mastered'),
    );
    for (const node of shaky.slice(0, 1)) {
      const est = 15;
      if (used + est <= budget) {
        tasks.push({
          kind: 'review',
          nodeId: node.id,
          repoId: null,
          estMinutes: est,
          orderIdx: tasks.length,
        });
        used += est;
      }
    }

    const baseMinutes = used;

    if (input.defaultRepoId && di % 2 === 1) {
      const est = 25;
      if (used + est <= budget) {
        tasks.push({
          kind: 'readCode',
          nodeId: null,
          repoId: input.defaultRepoId,
          estMinutes: est,
          orderIdx: tasks.length,
        });
        used += est;
      }
    }

    days.push({ dayIndex: di, date: dates[di]!, baseMinutes, plannedMinutes: used, tasks });
  }

  // 排不下的考点落到最后一天的兜底话术，不计入 plannedMinutes
  const lastDay = days.at(-1);
  while (nodeIdx < nodes.length && lastDay) {
    const node = nodes[nodeIdx]!;
    nodeIdx += 1;
    lastDay.tasks.push({
      kind: 'fallbackScript',
      nodeId: node.id,
      repoId: null,
      estMinutes: 10,
      orderIdx: 999,
    });
  }

  return days;
}

export interface CrossClientRepo {
  id: string;
  url: string;
  status: string;
}

/**
 * 桌面与手机共用的排程输入。两端各自落库后按 (date, orderIdx) 逐条比对，
 * 必须与 `crossClientLegacyPlan()` 完全一致。
 */
export const CROSS_CLIENT_PLAN = {
  campaignId: 'c-cross-client',
  today: '2026-03-02',
  interviewDate: '2026-03-08',
  dailyMinutes: 180,
  readyRepoId: 'repo-ready',
  repos: [
    { id: 'repo-ready', url: 'https://example.com/openjob', status: 'ready' },
    { id: 'repo-cloning', url: 'https://example.com/other', status: 'cloning' },
  ] as CrossClientRepo[],
  /** 难度与优先级全相同，备考顺序退化为 id 升序，两端必然一致 */
  nodes: Array.from({ length: 12 }, (_, index) => ({
    id: `n${String(index + 1).padStart(2, '0')}`,
    estMinutes: 20,
    difficulty: 3,
    priorityScore: 1,
    status: index === 2 ? 'shaky' : 'todo',
    mastery: 0,
  })),
} as const;

export function crossClientLegacyPlan(): LegacyPlanDay[] {
  return legacyPlan({
    today: CROSS_CLIENT_PLAN.today,
    interviewDate: CROSS_CLIENT_PLAN.interviewDate,
    dailyMinutes: CROSS_CLIENT_PLAN.dailyMinutes,
    nodes: CROSS_CLIENT_PLAN.nodes.map((node) => ({
      id: node.id,
      estMinutes: node.estMinutes,
      status: node.status,
      mastery: node.mastery,
    })),
    defaultRepoId: CROSS_CLIENT_PLAN.readyRepoId,
  });
}
