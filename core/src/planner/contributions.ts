/**
 * 插件任务的唯一决策点。
 *
 * 桌面 `src/main/plan/schedule.ts` 与手机 `mobile/src/data/planLocal.ts` 只负责读库
 * 和落库；任务节奏、时长、仓库选择和本机降级状态全部由这里决定，两端传入相同
 * PlannerContext 必须得到逐条相同的 PlannedTask。
 */
import type { RuntimeAvailability } from '../enums';
import {
  buildClientCapabilityView,
  type ClientDegradationReason,
  type ClientPluginStatus,
  type InstalledPlugin,
} from '../plugins/clientView';
import { hashRuntimeConfig } from '../plugins/resolver';
import type { RolePack, TaskTemplate } from '../plugins/types';
import type { CampaignRuntimeDescriptor, ClientPlatform } from '../plugins/types';

/** 本机跑不动时给用户的提示。内置能力插件的桌面端都是 full，降级只会发生在手机。 */
export const REQUIRES_DESKTOP_REASON = '需桌面完成';

/**
 * 排程看到的一份材料。
 *
 * 材料行的约定：行是包自己序列化的 JSON 字符串，宿主只认三个可选字段——
 * `id`（必需）、`label`（缺省用 id）、`ready`（布尔，缺省 false）。其余内容归
 * 包所有，宿主不解释。`materialsFromRows` 负责把原始行解析成这个形状。
 */
export interface PlannerMaterial {
  kind: string;
  id: string;
  label: string;
  ready: boolean;
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
  /** 全部材料，可用与否由贡献者按 ready 判断。 */
  materials: readonly PlannerMaterial[];
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
  /** 该任务由哪个包页面承担；缺省表示用宿主的考点视图。 */
  view?: { pageId: string };
}

/** 会真正落库的字段，两端必须逐条相同。 */
export interface PlannedTaskPayload {
  /** 任务种类；岗位包可以声明自己的种类，所以是字符串而不是闭集。 */
  kind: string;
  nodeId: string | null;
  /** 任务挂的材料类型；null 表示这个任务不带材料。 */
  materialKind: string | null;
  /** 材料标识，取自材料行的 id；null 表示不带材料。 */
  materialId: string | null;
  estMinutes: number;
}

export interface PlannedTask extends PlannedTaskPayload {
  contributionId: string;
  capabilityId: string;
  client: PlannedTaskClientView;
}

export interface PlannerContribution {
  id: string;
  /** 模板声明的任务名，宿主 UI 直接用它显示；岗位包换语言不需要宿主改文案。 */
  label: string;
  capabilityId: string;
  /** 声明了该任务模板的岗位包；其它岗位包即使启用同一能力也不排这个任务。 */
  rolePackIds: readonly string[];
  /** 由该贡献者产出的任务类型，已落库的任务靠它反查归属。 */
  taskKinds: readonly string[];
  /** 本机需要达到的运行能力，低于它就只能降级显示。 */
  minimumAvailability: RuntimeAvailability;
  /** 任务需要的材料类型；null 表示模板没声明，当前不排程。 */
  materialKind: string | null;
  /** 任务页落在哪个包页面。 */
  view?: { pageId: string };
  createTasks(context: PlannerContext): PlannedTaskPayload[];
}

const AVAILABILITY_RANK: Record<RuntimeAvailability, number> = {
  unsupported: 0,
  'view-only': 1,
  full: 2,
};

/**
 * 把包声明的材料行解析成排程认识的材料。
 *
 * 行是 JSON 字符串，宿主只读 id（必需）、label（缺省用 id）、ready（布尔，缺省
 * false）：解析不出、不是对象、或没有 id 的行一律跳过。两端传同一批行必须得到
 * 逐条相同的结果，所以不依赖任何读库顺序。
 */
export function materialsFromRows(
  kind: string,
  values: readonly (string | null)[],
): PlannerMaterial[] {
  const materials: PlannerMaterial[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const label = typeof record.label === 'string' && record.label.length > 0 ? record.label : id;
    materials.push({ kind, id, label, ready: record.ready === true });
  }
  return materials;
}

/** 有多份可用材料时按 (label, id) 取第一份，保证两端排到同一份。 */
function selectMaterial(
  materials: readonly PlannerMaterial[],
  kind: string,
): PlannerMaterial | null {
  return (
    [...materials]
      .filter((material) => material.kind === kind && material.ready)
      .sort(
        (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
      )
      .at(0) ?? null
  );
}

/**
 * 岗位包 taskTemplates → 排程贡献。
 *
 * 这是「core 认识任务节奏、不认识具体能力，也不认识任务种类」的落点：包声明了
 * 带 capabilityId 的任务模板（如 se.read-code → source-repository 能力），这里把它
 * 变成一个贡献者；包没声明就自然没有贡献——换一个没有源码能力的工程包，源码任务
 * 自动消失，core 不需要为任何具体岗位包写一行。
 *
 * 任务种类完全由模板声明（`taskKind`），宿主只按模板声明的 `materialKind` 判断
 * 「这个任务需要一份材料」：隔一天排一次、挑一份可用材料挂上、时长取模板
 * defaultMinutes。节奏是所有的材料型任务共用的通用语义，不认识任何具体种类。
 */
function contributionsFromRolePack(rolePack: RolePack): readonly PlannerContribution[] {
  return rolePack.taskTemplates
    .filter((template): template is TaskTemplate & { capabilityId: string } =>
      template.capabilityId !== undefined)
    .map((template) => ({
      id: template.id,
      label: template.label,
      capabilityId: template.capabilityId,
      rolePackIds: [rolePack.manifest.id],
      taskKinds: [template.taskKind],
      // 拉取、索引和更新只有桌面能做，手机只能读已同步的快照
      minimumAvailability: 'full' as RuntimeAvailability,
      materialKind: template.materialKind ?? null,
      ...(template.view ? { view: template.view } : {}),
      createTasks(context: PlannerContext): PlannedTaskPayload[] {
        // 没声明材料类型的任务当前没有排程语义：排出来也没东西可做
        if (template.materialKind === undefined) return [];
        if (context.dayIndex % 2 !== 1) return [];
        const material = selectMaterial(context.materials, template.materialKind);
        if (!material) return [];
        const estMinutes = template.defaultMinutes;
        if (context.usedMinutes + estMinutes > context.budgetMinutes) return [];
        return [
          {
            kind: template.taskKind,
            nodeId: null,
            materialKind: template.materialKind,
            materialId: material.id,
            estMinutes,
          },
        ];
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
  const view = buildClientCapabilityView({ descriptor: runtime, platform, installed });
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
    ...(contribution.view ? { view: contribution.view } : {}),
  };
}

/**
 * 任务名与任务页都取自岗位包声明：宿主不认识任务种类，也不为任何种类写文案。
 * 包不在本机或种类未声明时都返回 null，UI 回落到宿主的考点视图。
 */
export function taskPresentation(
  rolePack: RolePack | null,
  kind: string,
): { kindLabel: string | null; pageId: string | null } {
  const template = rolePack?.taskTemplates.find((item) => item.taskKind === kind);
  return { kindLabel: template?.label ?? null, pageId: template?.view?.pageId ?? null };
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
  taskKind: string,
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
 * 两端和迁移 SQL 共用这一个字面量：桌面 0027_pre_plugin_campaign_scope 与手机
 * 0025_pre_plugin_campaign_scope 负责打标，两端排程再据此判断该不该走工程岗兜底。
 * 只按 role_profile_id IS NULL 判断是不够的——新建战役同样是 NULL。
 */
export const PRE_PLUGIN_CAMPAIGN_SCOPE_KIND = 'generic-interview-v1:prePlugin';

/**
 * 迁移前的旧战役该落到哪个岗位包。
 *
 * 基础包不再点名任何岗位族（§6 判据一）：规则改成「取声明了**带材料任务模板**的岗位包」。
 * 迁移前的旧战役都是「带材料任务」的形态（当时的源码阅读任务挂着一份检出），所以本机装了
 * 那个包，旧战役就恢复原功能；没装就没有插件任务。多个候选取 id 最小者，保证两端一致。
 *
 * 这也是 `install.ts` 数据丢失把关的判据：装上的正是这个包，才算是「让旧数据恢复原功能」的
 * 路径，不触发确认。
 */
export function selectPrePluginRolePack(packs: readonly RolePack[]): RolePack | null {
  const candidates = packs
    .filter((pack) => isPrePluginRolePack(pack))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  return candidates[0] ?? null;
}

/**
 * 这个岗位包是不是「让迁移前旧数据恢复原功能」的那一个。
 *
 * 判据是包自己声明的形状（有带材料的任务模板），不是包 id——基础包不认识任何岗位族。
 * 安装路径用它决定装这个包要不要先提示数据丢失风险。
 */
export function isPrePluginRolePack(pack: RolePack): boolean {
  return pack.taskTemplates.some((template) => template.materialKind !== undefined);
}

/**
 * 带上述凭据、但 descriptor 还没回填出来的旧 Campaign，按本机判定的兜底岗位包执行。
 *
 * 兜底包由调用方用 `selectPrePluginRolePack` 从本机安装清单里选出，基础包不点名任何岗位族。
 * 字段与 `src/main/db/backfill/pluginRuntime.ts` 的回填默认值一致，使回填前后的
 * 排程结果不发生跳变。没有凭据的战役不走这里，见 `collectPlannerContributions`。
 *
 * 能力引用按岗位包的内嵌声明逐条产出（能力 id + 包版本），与 resolver 的产出规则一致：
 * 这条兜底路径现场重算 hash，形状不一致就会和已落库的 descriptor 对不上。
 */
export function descriptorFromRolePack(
  campaignId: string,
  pack: RolePack,
  options: { coreVersion: string; schemaVersion: number },
): CampaignRuntimeDescriptor {
  const rolePack = { id: pack.manifest.id, version: pack.manifest.version };
  const capabilities: CampaignRuntimeDescriptor['capabilities'] = (
    pack.capabilities ?? []
  ).map((declaration) => ({
    id: declaration.id,
    version: pack.manifest.version,
    enabled: true as const,
  }));
  return {
    campaignId,
    coreVersion: options.coreVersion,
    rolePack,
    capabilities,
    competencyBaselineVersion: pack.manifest.version,
    configSnapshotHash: hashRuntimeConfig({
      coreVersion: options.coreVersion,
      schemaVersion: options.schemaVersion,
      rolePack,
      industryVariantId: undefined,
      capabilities,
      competencyBaselineVersion: pack.manifest.version,
    }),
    resolvedAt: 0,
  };
}
