/**
 * 插件任务的唯一决策点。
 *
 * 桌面 `src/main/plan/schedule.ts` 与手机 `mobile/src/data/planLocal.ts` 只负责读库
 * 和落库；任务节奏、时长、仓库选择和本机降级状态全部由这里决定，两端传入相同
 * PlannerContext 必须得到逐条相同的 PlannedTask。
 */
import type { RuntimeAvailability, TaskKind } from '../enums';
import {
  SOFTWARE_ENGINEERING_ROLE_PACK_ID,
  softwareEngineeringRolePack,
} from '../plugins/builtin/softwareEngineering';
import {
  SOURCE_REPOSITORY_CAPABILITY_ID,
  sourceRepositoryCapabilityPlugin,
} from '../plugins/builtin/sourceRepository';
import { hashRuntimeConfig } from '../plugins/resolver';
import type {
  CampaignRuntimeDescriptor,
  ClientPlatform,
  PluginManifest,
  RolePack,
  TaskTemplate,
} from '../plugins/types';

/** 本机跑不动时给用户的提示。内置能力插件的桌面端都是 full，降级只会发生在手机。 */
export const REQUIRES_DESKTOP_REASON = '需桌面完成';

export interface PlannerRepo {
  id: string;
  url: string;
  status: string;
}

export interface PlannerContext {
  platform: ClientPlatform;
  /** 计划内的第几天，从 0 开始。 */
  dayIndex: number;
  dayCount: number;
  /** 当天可排的分钟上限（已按保守系数打过折）。 */
  budgetMinutes: number;
  /** 当天已被基础任务占用的分钟数。 */
  usedMinutes: number;
  /** 全部仓库，可用与否由贡献者判断。 */
  repos: readonly PlannerRepo[];
}

/**
 * 任务在当前客户端的可执行状态。
 *
 * 不可执行的任务照样生成并落库：两端计划必须一致，手机只是显示为
 * 「需桌面完成」，而不是静默丢弃。
 */
export interface PlannedTaskClientView {
  platform: ClientPlatform;
  availability: RuntimeAvailability;
  executable: boolean;
  blockedReason: string | null;
}

/** 会真正落库的字段，两端必须逐条相同。 */
export interface PlannedTaskPayload {
  kind: TaskKind;
  nodeId: string | null;
  repoId: string | null;
  estMinutes: number;
}

export interface PlannedTask extends PlannedTaskPayload {
  contributionId: string;
  capabilityId: string;
  client: PlannedTaskClientView;
}

export interface PlannerContribution {
  id: string;
  capabilityId: string;
  /** 声明了该任务模板的岗位包；其它岗位包即使启用同一能力也不排这个任务。 */
  rolePackIds: readonly string[];
  /** 由该贡献者产出的任务类型，已落库的任务靠它反查归属。 */
  taskKinds: readonly TaskKind[];
  /** 本机需要达到的运行能力，低于它就只能降级显示。 */
  minimumAvailability: RuntimeAvailability;
  createTasks(context: PlannerContext): PlannedTaskPayload[];
}

const AVAILABILITY_RANK: Record<RuntimeAvailability, number> = {
  unsupported: 0,
  'view-only': 1,
  full: 2,
};

const BUILT_IN_CAPABILITY_MANIFESTS: readonly PluginManifest[] = [
  sourceRepositoryCapabilityPlugin.manifest,
];

function requireTaskTemplate(
  pack: RolePack,
  taskKind: TaskKind,
  capabilityId: string,
): TaskTemplate {
  const template = pack.taskTemplates.find(
    (item) => item.taskKind === taskKind && item.capabilityId === capabilityId,
  );
  if (!template) throw new Error(`岗位包 ${pack.manifest.id} 缺少任务模板：${taskKind}`);
  return template;
}

const READ_CODE_TEMPLATE = requireTaskTemplate(
  softwareEngineeringRolePack,
  'readCode',
  SOURCE_REPOSITORY_CAPABILITY_ID,
);

/** 有多个已索引仓库时按 (url, id) 取第一个，保证两端选到同一个仓库。 */
function defaultRepo(repos: readonly PlannerRepo[]): PlannerRepo | null {
  return (
    [...repos]
      .filter((repo) => repo.status === 'ready')
      .sort((left, right) => left.url.localeCompare(right.url) || left.id.localeCompare(right.id))
      .at(0) ?? null
  );
}

const readCodeContribution: PlannerContribution = {
  id: 'source-repository.read-code',
  capabilityId: SOURCE_REPOSITORY_CAPABILITY_ID,
  rolePackIds: [SOFTWARE_ENGINEERING_ROLE_PACK_ID],
  taskKinds: ['readCode'],
  // 克隆、索引和更新只有桌面能做，手机只能读已同步的快照
  minimumAvailability: 'full',
  createTasks(context) {
    // 隔一天排一次，且当天预算装得下才排——与插件化之前两端的排程节奏一致
    if (context.dayIndex % 2 !== 1) return [];
    const repo = defaultRepo(context.repos);
    if (!repo) return [];
    const estMinutes = READ_CODE_TEMPLATE.defaultMinutes;
    if (context.usedMinutes + estMinutes > context.budgetMinutes) return [];
    return [{ kind: 'readCode', nodeId: null, repoId: repo.id, estMinutes }];
  },
};

const PLANNER_CONTRIBUTIONS: readonly PlannerContribution[] = [readCodeContribution];

function availabilityFor(manifest: PluginManifest, platform: ClientPlatform): RuntimeAvailability {
  return manifest.runtime?.[platform] ?? 'full';
}

function clientView(
  manifest: PluginManifest,
  contribution: PlannerContribution,
  platform: ClientPlatform,
): PlannedTaskClientView {
  const availability = availabilityFor(manifest, platform);
  const executable =
    AVAILABILITY_RANK[availability] >= AVAILABILITY_RANK[contribution.minimumAvailability];
  return {
    platform,
    availability,
    executable,
    blockedReason: executable ? null : REQUIRES_DESKTOP_REASON,
  };
}

/**
 * 取 descriptor 固定的那个精确版本。
 *
 * 版本没安装时返回 null：按架构第 8.6 节，固定版本不可用只保留历史结果，
 * 不再生成新的插件任务。
 */
function activeManifest(
  runtime: CampaignRuntimeDescriptor,
  contribution: PlannerContribution,
): PluginManifest | null {
  if (!contribution.rolePackIds.includes(runtime.rolePack.id)) return null;
  const resolved = runtime.capabilities.find((item) => item.id === contribution.capabilityId);
  if (!resolved?.enabled) return null;
  return (
    BUILT_IN_CAPABILITY_MANIFESTS.find(
      (manifest) =>
        manifest.id === contribution.capabilityId && manifest.version === resolved.version,
    ) ?? null
  );
}

export function collectPlannerContributions(
  runtime: CampaignRuntimeDescriptor,
  context: PlannerContext,
): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  let usedMinutes = context.usedMinutes;

  for (const contribution of PLANNER_CONTRIBUTIONS) {
    const manifest = activeManifest(runtime, contribution);
    if (!manifest) continue;
    const client = clientView(manifest, contribution, context.platform);
    for (const payload of contribution.createTasks({ ...context, usedMinutes })) {
      tasks.push({
        ...payload,
        contributionId: contribution.id,
        capabilityId: contribution.capabilityId,
        client,
      });
      usedMinutes += payload.estMinutes;
    }
  }

  return tasks;
}

/**
 * 已落库任务在本机的可执行状态，`null` 表示该任务不由插件贡献。
 *
 * 计划生成之后 UI 只拿得到 task 行，降级提示需要按当前 descriptor 重新判定。
 */
export function pluginTaskClientView(
  runtime: CampaignRuntimeDescriptor,
  taskKind: TaskKind,
  platform: ClientPlatform,
): PlannedTaskClientView | null {
  for (const contribution of PLANNER_CONTRIBUTIONS) {
    if (!contribution.taskKinds.includes(taskKind)) continue;
    const manifest = activeManifest(runtime, contribution);
    if (!manifest) continue;
    return clientView(manifest, contribution, platform);
  }
  return null;
}

/**
 * 尚未回填 descriptor 的 Campaign 继续按工程岗位包执行。
 *
 * 字段与 `src/main/db/backfill/pluginRuntime.ts` 的回填默认值一致，使回填前后的
 * 排程结果不发生跳变。
 */
export function legacyRuntimeDescriptor(campaignId: string): CampaignRuntimeDescriptor {
  const coreVersion = '1.0.0';
  const schemaVersion = 23;
  const rolePack = {
    id: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
    version: softwareEngineeringRolePack.manifest.version,
  };
  const capabilities: CampaignRuntimeDescriptor['capabilities'] = [
    {
      id: SOURCE_REPOSITORY_CAPABILITY_ID,
      version: sourceRepositoryCapabilityPlugin.manifest.version,
      enabled: true,
    },
  ];
  return {
    campaignId,
    coreVersion,
    rolePack,
    capabilities,
    competencyBaselineVersion: rolePack.version,
    configSnapshotHash: hashRuntimeConfig({
      coreVersion,
      schemaVersion,
      rolePack,
      industryPack: undefined,
      capabilities,
      competencyBaselineVersion: rolePack.version,
    }),
    resolvedAt: 0,
  };
}
