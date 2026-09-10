/**
 * 桌面排程改由共享 PlannerContribution 决定插件任务后，节奏必须一条不差。
 *
 * 判据是 `__fixtures__/legacyPlan` 里照搬的插件化之前的算法；手机端
 * `mobile/src/data/planLocal.test.ts` 用同一份输入和同一个判据比对，
 * 两端结果因此可以逐条对齐。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CAMPAIGN_SCOPE_KIND,
  legacyRuntimeDescriptor,
} from '@shared/planner/contributions';
import {
  CROSS_CLIENT_PLAN,
  crossClientLegacyPlan,
  type LegacyPlanDay,
} from '@shared/planner/__fixtures__/legacyPlan';
import * as schema from '../db/schema';
import {
  LEGACY_CORE_VERSION,
  LEGACY_REPOSITORY_CAPABILITY_ID,
  LEGACY_REPOSITORY_CAPABILITY_VERSION,
  LEGACY_ROLE_PACK_ID,
  LEGACY_ROLE_PACK_VERSION,
} from '../db/backfill/pluginRuntime';

interface PlanDayRow {
  id: string;
  campaignId: string;
  date: string;
  plannedMinutes: number;
}

interface TaskRow {
  planDayId: string;
  nodeId: string | null;
  repoId: string | null;
  kind: string;
  estMinutes: number;
  orderIdx: number;
}

interface FlatTask {
  date: string;
  kind: string;
  nodeId: string | null;
  repoId: string | null;
  estMinutes: number;
  orderIdx: number;
}

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../db', async () => {
  const real = await import('../db/schema');
  return { getDb: () => dbRef.current, schema: real };
});

vi.mock('../campaign/repository', () => ({
  getCampaignRow: (id: string) => ({
    id,
    company: 'ACME',
    roleTitle: '后端工程师',
    interviewDate: null,
    dailyMinutes: null,
    status: 'planning',
  }),
  listCampaigns: () => [],
  rowToNode: (row: unknown) => row,
  updateCampaign: () => undefined,
}));

vi.mock('./session', () => ({
  recordPlanChange: () => undefined,
  recordPlanDecision: () => undefined,
}));

const { generatePlan } = await import('./schedule');

interface Captured {
  planDays: PlanDayRow[];
  tasks: TaskRow[];
}

/** 只实现 generatePlan 用到的那几条 drizzle 链，按表返回对应行 */
function fakeDb(options: {
  descriptor: Record<string, unknown> | null;
  repos?: Array<{ id: string; url: string; status: string }>;
  /** 是否带「插件化之前就存在」的凭据：决定没有 descriptor 时走不走工程岗兜底 */
  legacyScoped?: boolean;
}): Captured {
  const captured: Captured = { planDays: [], tasks: [] };
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.knowledgeNode) {
      return CROSS_CLIENT_PLAN.nodes.map((node) => ({
        ...node,
        campaignId: CROSS_CLIENT_PLAN.campaignId,
        name: node.id,
        kind: 'point',
        coverageType: 'deepDive',
      }));
    }
    if (table === schema.repo) return options.repos ?? [...CROSS_CLIENT_PLAN.repos];
    if (table === schema.planDay) return captured.planDays;
    if (table === schema.campaignRuntimeDescriptor) {
      return options.descriptor ? [options.descriptor] : [];
    }
    if (table === schema.migrationCheckpoint) {
      return options.legacyScoped
        ? [
            {
              id: `${LEGACY_CAMPAIGN_SCOPE_KIND}:${CROSS_CLIENT_PLAN.campaignId}`,
              campaignId: CROSS_CLIENT_PLAN.campaignId,
              kind: LEGACY_CAMPAIGN_SCOPE_KIND,
              completedAt: 1,
            },
          ]
        : [];
    }
    return [];
  };

  const chain = (table: unknown): Record<string, unknown> => {
    const terminal: Record<string, unknown> = {
      all: () => rowsFor(table),
      get: () => rowsFor(table).at(-1),
    };
    terminal.where = () => terminal;
    terminal.orderBy = () => terminal;
    return terminal;
  };

  dbRef.current = {
    select: () => ({ from: (table: unknown) => chain(table) }),
    insert: (table: unknown) => ({
      values: (row: PlanDayRow | TaskRow) => ({
        run: () => {
          if (table === schema.planDay) captured.planDays.push(row as PlanDayRow);
          else captured.tasks.push(row as TaskRow);
        },
      }),
    }),
    delete: () => ({ where: () => ({ run: () => undefined }) }),
    update: () => ({ set: () => ({ where: () => ({ run: () => undefined }) }) }),
  };

  return captured;
}

function descriptorRow(
  capabilities: unknown = [
    {
      id: LEGACY_REPOSITORY_CAPABILITY_ID,
      version: LEGACY_REPOSITORY_CAPABILITY_VERSION,
      enabled: true,
    },
  ],
): Record<string, unknown> {
  return {
    id: 'descriptor-1',
    campaignId: CROSS_CLIENT_PLAN.campaignId,
    revision: 1,
    coreVersion: LEGACY_CORE_VERSION,
    rolePack: { id: LEGACY_ROLE_PACK_ID, version: LEGACY_ROLE_PACK_VERSION },
    industryPack: null,
    capabilities,
    competencyBaselineVersion: LEGACY_ROLE_PACK_VERSION,
    configSnapshotHash: 'hash',
    resolvedAt: 1,
  };
}

function flatten(captured: Captured): FlatTask[] {
  const dateById = new Map(captured.planDays.map((day) => [day.id, day.date]));
  return captured.tasks
    .map((task) => ({
      date: dateById.get(task.planDayId)!,
      kind: task.kind,
      nodeId: task.nodeId,
      repoId: task.repoId,
      estMinutes: task.estMinutes,
      orderIdx: task.orderIdx,
    }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.orderIdx - right.orderIdx);
}

function expectedTasks(days: LegacyPlanDay[]): FlatTask[] {
  return days
    .flatMap((day) => day.tasks.map((task) => ({ date: day.date, ...task })))
    .sort((left, right) => left.date.localeCompare(right.date) || left.orderIdx - right.orderIdx);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${CROSS_CLIENT_PLAN.today}T09:00:00`));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('generatePlan', () => {
  it('启用 source-repository 且有已索引仓库时，排出的计划与插件化之前逐条一致', () => {
    const captured = fakeDb({ descriptor: descriptorRow() });

    const result = generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    const days = crossClientLegacyPlan();
    expect(result).toEqual({
      daysCreated: days.length,
      tasksCreated: days.reduce((sum, day) => sum + day.tasks.length, 0),
      overflowFallbacks: 0,
    });
    expect(flatten(captured)).toEqual(expectedTasks(days));
    expect(captured.planDays.map((day) => [day.date, day.plannedMinutes])).toEqual(
      days.map((day) => [day.date, day.plannedMinutes]),
    );
    // 隔天一条源码任务，节奏不能变
    expect(flatten(captured).filter((task) => task.kind === 'readCode')).toEqual([
      {
        date: '2026-03-03',
        kind: 'readCode',
        nodeId: null,
        repoId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 5,
      },
      {
        date: '2026-03-05',
        kind: 'readCode',
        nodeId: null,
        repoId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 5,
      },
      {
        date: '2026-03-07',
        kind: 'readCode',
        nodeId: null,
        repoId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 2,
      },
    ]);
  });

  it('未启用 source-repository 时不生成 readCode，其余任务不受影响', () => {
    const captured = fakeDb({
      descriptor: descriptorRow([
        {
          id: LEGACY_REPOSITORY_CAPABILITY_ID,
          enabled: false,
          disabledReason: '用户已关闭源码能力',
        },
      ]),
    });

    generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    const withoutPluginTasks = expectedTasks(crossClientLegacyPlan()).filter(
      (task) => task.kind !== 'readCode',
    );
    expect(flatten(captured)).toEqual(withoutPluginTasks);
  });

  it('仓库还没索引完时不生成 readCode', () => {
    const captured = fakeDb({
      descriptor: descriptorRow(),
      repos: [{ id: 'repo-cloning', url: 'https://example.com/other', status: 'cloning' }],
    });

    generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(flatten(captured).some((task) => task.kind === 'readCode')).toBe(false);
  });

  it('descriptor 还没回填的旧 Campaign 继续按工程岗位包排源码任务', () => {
    const captured = fakeDb({ descriptor: null, legacyScoped: true });

    generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(flatten(captured)).toEqual(expectedTasks(crossClientLegacyPlan()));
  });

  /**
   * 与上一条成对：两者都没有 descriptor，差别只在有没有旧数据凭据。
   * 新建战役不该因为「还没选岗位」就被当成工程岗，否则用户一建战役就看到源码任务。
   */
  it('还没选岗位的新 Campaign 不排源码任务，其余任务照排', () => {
    const captured = fakeDb({ descriptor: null });

    generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    const withoutPluginTasks = expectedTasks(crossClientLegacyPlan()).filter(
      (task) => task.kind !== 'readCode',
    );
    expect(flatten(captured)).toEqual(withoutPluginTasks);
  });
});

describe('legacyRuntimeDescriptor', () => {
  it('与 T03 的回填默认值一致，回填前后排程不跳变', () => {
    const fallback = legacyRuntimeDescriptor(CROSS_CLIENT_PLAN.campaignId);

    expect(fallback.coreVersion).toBe(LEGACY_CORE_VERSION);
    expect(fallback.rolePack).toEqual({
      id: LEGACY_ROLE_PACK_ID,
      version: LEGACY_ROLE_PACK_VERSION,
    });
    expect(fallback.capabilities).toEqual([
      {
        id: LEGACY_REPOSITORY_CAPABILITY_ID,
        version: LEGACY_REPOSITORY_CAPABILITY_VERSION,
        enabled: true,
      },
    ]);
  });
});
