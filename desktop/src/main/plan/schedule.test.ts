/**
 * 桌面排程改由共享 PlannerContribution 决定插件任务后，节奏必须一条不差。
 *
 * 判据是 `__fixtures__/prePluginPlan` 里照搬的插件化之前的算法；手机端
 * `mobile/src/data/planLocal.test.ts` 用同一份输入和同一个判据比对，
 * 两端结果因此可以逐条对齐。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRE_PLUGIN_CAMPAIGN_SCOPE_KIND,
  descriptorFromRolePack,
} from '@core/planner/contributions';
import {
  CROSS_CLIENT_PLAN,
  crossClientPrePluginPlan,
  type PrePluginPlanDay,
} from '@core/planner/__fixtures__/prePluginPlan';
import * as schema from '../db/schema';
import { installedRolePackEntry } from '../plugins/__fixtures__/installedPlugins';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { setExternalPlugins } from '../plugins/runtime';
import type { CampaignRuntimeDescriptor } from '@core/plugins/types';

interface PlanDayRow {
  id: string;
  campaignId: string;
  date: string;
  plannedMinutes: number;
}

interface TaskRow {
  planDayId: string;
  nodeId: string | null;
  materialKind: string | null;
  materialId: string | null;
  kind: string;
  estMinutes: number;
  orderIdx: number;
}

interface FlatTask {
  date: string;
  kind: string;
  nodeId: string | null;
  materialKind: string | null;
  materialId: string | null;
  estMinutes: number;
  orderIdx: number;
}

/** 岗位包模板声明的材料类型；排程只按它挑材料。 */
const MATERIAL_KIND = 'code-repository';

/** 包自己声明的材料行；宿主只按 (kind, collection) 取数后交给 materialsFromRows 解析。 */
interface MaterialRow {
  id: string;
  label: string;
  ready: boolean;
}

/**
 * 旧仓库登记表 → 包声明的材料行。
 *
 * label 就是仓库 url、ready 由 status 归一化——与 0029_task_material 迁移写进
 * plugin_data 的取值逐字一致，所以这里的默认值与真实旧库升级后的形状同源。
 */
function materialRows(
  rows: readonly { id: string; url: string; status: string }[],
): MaterialRow[] {
  return rows.map((row) => ({ id: row.id, label: row.url, ready: row.status === 'ready' }));
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
  /** 包声明的数据集合里的材料行；缺省取共享夹具（插件化迁移后的旧库形状）。 */
  materials?: MaterialRow[];
  /** 是否带「插件化之前就存在」的凭据：决定没有 descriptor 时走不走工程岗兜底 */
  prePluginScoped?: boolean;
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
    // 排程不再读 repo 表：材料由岗位包声明的 (materialKind, materialCollection) 取数，
    // 宿主按 (plugin_id, collection) 查 plugin_data，把 value_json 原样交给 materialsFromRows。
    if (table === schema.pluginData) {
      const materials = options.materials ?? materialRows(CROSS_CLIENT_PLAN.repos);
      return materials.map((material) => ({ value: JSON.stringify(material) }));
    }
    if (table === schema.planDay) return captured.planDays;
    if (table === schema.campaignRuntimeDescriptor) {
      return options.descriptor ? [options.descriptor] : [];
    }
    if (table === schema.migrationCheckpoint) {
      return options.prePluginScoped
        ? [
            {
              id: `${PRE_PLUGIN_CAMPAIGN_SCOPE_KIND}:${CROSS_CLIENT_PLAN.campaignId}`,
              campaignId: CROSS_CLIENT_PLAN.campaignId,
              kind: PRE_PLUGIN_CAMPAIGN_SCOPE_KIND,
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
      id: 'source-repository',
      version: '1.0.0',
      enabled: true,
    },
  ],
): Record<string, unknown> {
  return {
    id: 'descriptor-1',
    campaignId: CROSS_CLIENT_PLAN.campaignId,
    revision: 1,
    coreVersion: '1.0.0',
    rolePack: { id: 'software-engineering', version: '1.0.0' },
    industryPack: null,
    capabilities,
    competencyBaselineVersion: '1.0.0',
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
      materialKind: task.materialKind,
      materialId: task.materialId,
      estMinutes: task.estMinutes,
      orderIdx: task.orderIdx,
    }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.orderIdx - right.orderIdx);
}

function expectedTasks(days: PrePluginPlanDay[]): FlatTask[] {
  return days
    .flatMap((day) =>
      day.tasks.map((task) => ({
        date: day.date,
        kind: task.kind,
        nodeId: task.nodeId,
        // 插件化之前的计划只记仓库标识；迁移把它原样搬成 material_id，
        // 材料种类由岗位包模板声明——只有挂了仓库的任务带材料。
        materialKind: task.repoId === null ? null : MATERIAL_KIND,
        materialId: task.repoId,
        estMinutes: task.estMinutes,
        orderIdx: task.orderIdx,
      })),
    )
    .sort((left, right) => left.date.localeCompare(right.date) || left.orderIdx - right.orderIdx);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${CROSS_CLIENT_PLAN.today}T09:00:00`));
  // 排程按本机安装清单判能力，而能力随岗位包派生：装上岗位包，readCode 才会被排进计划
  // （与生产安装链路同构）
  setExternalPlugins([installedRolePackEntry(softwareEngineeringRolePack)]);
});

afterEach(() => {
  setExternalPlugins([]);
  vi.useRealTimers();
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

    const days = crossClientPrePluginPlan();
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
        materialKind: MATERIAL_KIND,
        materialId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 5,
      },
      {
        date: '2026-03-05',
        kind: 'readCode',
        nodeId: null,
        materialKind: MATERIAL_KIND,
        materialId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 5,
      },
      {
        date: '2026-03-07',
        kind: 'readCode',
        nodeId: null,
        materialKind: MATERIAL_KIND,
        materialId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 2,
      },
    ]);
  });

  it('未启用 source-repository 时不生成 readCode，其余任务不受影响', () => {
    const captured = fakeDb({
      descriptor: descriptorRow([
        {
          id: 'source-repository',
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

    const withoutPluginTasks = expectedTasks(crossClientPrePluginPlan()).filter(
      (task) => task.kind !== 'readCode',
    );
    expect(flatten(captured)).toEqual(withoutPluginTasks);
  });

  it('仓库还没索引完时不生成 readCode', () => {
    const captured = fakeDb({
      descriptor: descriptorRow(),
      materials: [{ id: 'repo-cloning', label: 'https://example.com/other', ready: false }],
    });

    generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(flatten(captured).some((task) => task.kind === 'readCode')).toBe(false);
  });

  it('descriptor 还没回填的旧 Campaign 继续按工程岗位包排源码任务', () => {
    const captured = fakeDb({ descriptor: null, prePluginScoped: true });

    generatePlan(
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(flatten(captured)).toEqual(expectedTasks(crossClientPrePluginPlan()));
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

    const withoutPluginTasks = expectedTasks(crossClientPrePluginPlan()).filter(
      (task) => task.kind !== 'readCode',
    );
    expect(flatten(captured)).toEqual(withoutPluginTasks);
  });
});


/** pre-plugin fallback 的测试替身：与 schedule.ts 同一条 descriptorFromRolePack 路径。 */
function prePluginFallbackDescriptorForTest(campaignId: string): CampaignRuntimeDescriptor {
  return descriptorFromRolePack(campaignId, softwareEngineeringRolePack, {
    coreVersion: '1.0.0',
    schemaVersion: 24,
  });
}

describe('pre-plugin fallback descriptor', () => {
  it('从已安装的软件工程包构建：插件装上即原功能', () => {
    const fallback = prePluginFallbackDescriptorForTest(CROSS_CLIENT_PLAN.campaignId);

    expect(fallback.rolePack).toEqual({
      id: 'software-engineering',
      version: softwareEngineeringRolePack.manifest.version,
    });
    // 能力引用按包内嵌声明逐条产出：能力 id + 所属包版本
    expect(fallback.capabilities).toEqual([
      { id: 'source-repository', version: softwareEngineeringRolePack.manifest.version, enabled: true },
    ]);
  });
});
