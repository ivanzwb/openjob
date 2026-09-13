/**
 * 插件任务的唯一决策点。
 *
 * 桌面 `src/main/plan/schedule.ts` 与手机 `mobile/src/data/planLocal.ts` 只负责读库
 * 和落库；任务节奏、时长、仓库选择和本机降级状态全部由这里决定，两端传入相同
 * PlannerContext 必须得到逐条相同的 PlannedTask。
 */
import type { RuntimeAvailability, TaskKind } from '../enums';
// readCode 任务的常量：工程岗位包专属，snapshot 值与包 tasks.ts 保持一致
const SOURCE_REPOSITORY_CAPABILITY_ID = 'source-repository';
import {
  buildClientCapabilityView,
  type ClientDegradationReason,
  type ClientPluginStatus,
  type InstalledPlugin,
} from '../plugins/clientView';
import { LEGACY_ROLE_PACK_REF } from '../plugins/legacyRoleData';
import {
  normalizeCapabilityRefs,

} from '../plugins/capabilitySuite';
import { hashRuntimeConfig } from '../plugins/resolver';
import type { RolePack, TaskTemplate } from '../plugins/types';
import type { CampaignRuntimeDescriptor, ClientPlatform } from '../plugins/types';

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
  /**
   * 本机的插件安装清单。
   *
   * 曾经这里读内置清单（`listBuiltInPlugins()`），因为能力插件随应用发布；能力
   * 改由单独安装的合编包提供之后，内置恒为空——继续读内置会让「装了能力包也不
   * 排任务」，而且不会报错。两端各自取真实安装集合传进来（桌面 runtime、手机角色包缓存）。
   */
  installed: readonly InstalledPlugin[];
  /**
   * 该 Campaign 岗位包解析到的本机数据（按 descriptor pin 的版本；pin 版本不在本机时
   * 退回同 id 最新已装包——排程反映「现在装着什么」，与练习的精确版本要求不同）。
   * null = 岗位包不在本机：插件任务无从派生，只走基础任务。
   */
  rolePack: RolePack | null;
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

/** 有多个已索引仓库时按 (url, id) 取第一个，保证两端选到同一个仓库。 */
function defaultRepo(repos: readonly PlannerRepo[]): PlannerRepo | null {
  return (
    [...repos]
      .filter((repo) => repo.status === 'ready')
      .sort((left, right) => left.url.localeCompare(right.url) || left.id.localeCompare(right.id))
      .at(0) ?? null
  );
}

/**
 * 岗位包 taskTemplates → 排程贡献。
 *
 * 这是「core 认识任务节奏、不认识具体能力」的落点：包声明了带 capabilityId 的
 * 任务模板（如 se.read-code → source-repository 能力），这里把它变成一个贡献者；
 * 包没声明就自然没有贡献——换一个没有源码能力的工程包，源码任务自动消失，
 * core 不需要为任何具体岗位包写一行。
 *
 * 调度节奏按 taskKind 由宿主语义决定（目前只有 readCode 有排程节奏：隔天一次、
 * 选已索引仓库、时长取模板 defaultMinutes）；其它 taskKind 的能力任务暂无节奏
 * 语义，不排。
 */
function contributionsFromRolePack(rolePack: RolePack): readonly PlannerContribution[] {
  return rolePack.taskTemplates
    .filter((template): template is TaskTemplate & { capabilityId: string } =>
      template.capabilityId !== undefined)
    .map((template) => ({
      id: template.id,
      capabilityId: template.capabilityId,
      rolePackIds: [rolePack.manifest.id],
      taskKinds: [template.taskKind as TaskKind],
      // 克隆、索引和更新只有桌面能做，手机只能读已同步的快照
      minimumAvailability: 'full' as RuntimeAvailability,
      createTasks(context: PlannerContext): PlannedTaskPayload[] {
        if (template.taskKind !== 'readCode') return [];
        // 隔一天排一次，且当天预算装得下才排——与插件化之前两端的排程节奏一致
        if (context.dayIndex % 2 !== 1) return [];
        const repo = defaultRepo(context.repos);
        if (!repo) return [];
        const estMinutes = template.defaultMinutes;
        if (context.usedMinutes + estMinutes > context.budgetMinutes) return [];
        return [{ kind: 'readCode', nodeId: null, repoId: repo.id, estMinutes }];
      },
    }));
}

/**
 * 本机对该能力的判定。
 *
 * 平台可用性只在 clientView 一处算，排程不自己读 Manifest——两处各判一次时，
 * 「本机能做什么」迟早会漂移。
 *
 * `installed` 用调用方传来的本机真实安装清单（桌面 runtime、手机角色包缓存）。
 * 曾经这里读内置清单，因为能力随应用发布；能力改为单独安装的合编包后内置恒为空，
 * 再读内置会让已装能力包也不排任务。岗位包装没装不影响这里的判定——上面那行
 * rolePackIds 已经按 descriptor 判过是不是该排这个任务了。
 */
function capabilityStatus(
  runtime: CampaignRuntimeDescriptor,
  contribution: PlannerContribution,
  platform: ClientPlatform,
  installed: readonly InstalledPlugin[],
): ClientPluginStatus | null {
  if (!contribution.rolePackIds.includes(runtime.rolePack.id)) return null;
  const view = buildClientCapabilityView({
    // 旧战役的 descriptor 还 pin 着三个退役 id（历史事实，不能改写）：判定前归一成
    // 合编包 id，否则装了合编包也会判成 plugin-not-installed，回填窗口内排程会跳变
    descriptor: { ...runtime, capabilities: normalizeCapabilityRefs(runtime.capabilities) },
    platform,
    installed,
  });
  const status = view.capabilities.find((item) => item.id === contribution.capabilityId) ?? null;
  if (
    status?.reason === 'pinned-version-unavailable' &&
    installed.some((item) => item.id === status.id)
  ) {
    // 插件装上即功能一致（同 id 任意已装版本）：pin 版本缺失不阻断排程，
    // 按已装版本的运行能力放行；每次 attempt 自带 rubric/prompt 版本，历史仍可解释
    const current = installed.find((item) => item.id === status.id)!;
    // InstalledPlugin 的 runtime 声明决定该平台的运行能力（与 clientView 同一事实源）
    const mode = current.runtime ? current.runtime[platform] : ('full' as RuntimeAvailability);
    return { ...status, version: current.version, mode, reason: null };
  }
  return status;
}

/** 这些降级只保留历史结果，不再生成新的插件任务（§8.6）。
 * 注意 pinned-version-unavailable 不在此列：插件装上即功能一致（同 id 任意版本），
 * capabilityStatus 已把这种情况放行为已装版本的运行能力。 */
const NO_NEW_TASK_REASONS: readonly ClientDegradationReason[] = [
  'capability-disabled',
  'plugin-not-installed',
];

/** 返回 null 表示该贡献者当前不排任务；平台能力不足只降级，不停排。 */
function activeClientView(
  runtime: CampaignRuntimeDescriptor,
  contribution: PlannerContribution,
  platform: ClientPlatform,
  installed: readonly InstalledPlugin[],
): PlannedTaskClientView | null {
  const status = capabilityStatus(runtime, contribution, platform, installed);
  if (!status) return null;
  if (status.reason !== null && NO_NEW_TASK_REASONS.includes(status.reason)) return null;

  const executable =
    AVAILABILITY_RANK[status.mode] >= AVAILABILITY_RANK[contribution.minimumAvailability];
  return {
    platform,
    availability: status.mode,
    executable,
    blockedReason: executable ? null : REQUIRES_DESKTOP_REASON,
  };
}

/**
 * `runtime` 为 null 表示这个 Campaign 还没选岗位，因此没有任何插件贡献。
 *
 * 不能拿工程岗兜底：那会让「还没选岗位」和「选了工程岗」排出同一份计划，用户看到
 * 一堆源码任务，却在岗位表单里看不出是谁决定的。
 */
export function collectPlannerContributions(
  runtime: CampaignRuntimeDescriptor | null,
  context: PlannerContext,
): PlannedTask[] {
  if (!runtime) return [];
  if (!context.rolePack) return [];

  const tasks: PlannedTask[] = [];
  let usedMinutes = context.usedMinutes;

  for (const contribution of contributionsFromRolePack(context.rolePack)) {
    const client = activeClientView(runtime, contribution, context.platform, context.installed);
    if (!client) continue;
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
  runtime: CampaignRuntimeDescriptor | null,
  taskKind: TaskKind,
  platform: ClientPlatform,
  installed: readonly InstalledPlugin[],
  rolePack: RolePack | null,
): PlannedTaskClientView | null {
  if (!runtime) return null;

  for (const contribution of contributionsFromRolePack(rolePack ?? { taskTemplates: [] } as unknown as RolePack)) {
    if (!contribution.taskKinds.includes(taskKind)) continue;
    const client = activeClientView(runtime, contribution, platform, installed);
    if (!client) continue;
    return client;
  }
  return null;
}

/**
 * 「插件化迁移那一刻就已存在」的 Campaign 凭据，写在 migration_checkpoint.kind 上。
 *
 * 两端和迁移 SQL 共用这一个字面量：桌面 0027_legacy_campaign_scope 与手机
 * 0025_legacy_campaign_scope 负责打标，两端排程再据此判断该不该走工程岗兜底。
 * 只按 role_profile_id IS NULL 判断是不够的——新建战役同样是 NULL。
 */
export const LEGACY_CAMPAIGN_SCOPE_KIND = 'generic-interview-v1:legacy';

/**
 * 带上述凭据、但 descriptor 还没回填出来的旧 Campaign 继续按工程岗位包执行。
 *
 * 字段与 `src/main/db/backfill/pluginRuntime.ts` 的回填默认值一致，使回填前后的
 * 排程结果不发生跳变。没有凭据的战役不走这里，见 `collectPlannerContributions`。
 *
 * 这里的 `source-repository@1.0.0` 是**历史事实**：那时它是内置能力。旧战役的
 * binding/descriptor 也 pin 着这个 id，投影与 hash 都按它算——不要跟着合编包改名，
 * 否则旧记录的 config_snapshot_hash 会跳变（同样的理由见 legacyRoleData）。
 */
export function legacyRuntimeDescriptor(campaignId: string): CampaignRuntimeDescriptor {
  const coreVersion = '1.0.0';
  const schemaVersion = 23;
  const rolePack = { ...LEGACY_ROLE_PACK_REF };
  const capabilities: CampaignRuntimeDescriptor['capabilities'] = [
    {
      id: SOURCE_REPOSITORY_CAPABILITY_ID,
      version: '1.0.0',
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
