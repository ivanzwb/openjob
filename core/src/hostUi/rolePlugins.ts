/**
 * 岗位确认表单的取数与回执核对。
 *
 * 界面上要回答三个问题：这场备考挂的是哪个岗位包、级别是什么、哪些能力插件在生效。
 * 三个答案全部来自 descriptor 与本机安装清单，没有一处从 `campaign.roleTitle` 之类的
 * 岗位标题文本猜出来——一旦界面开始自己判断「标题里有 backend 就按工程岗渲染」，
 * resolver 解析出的那份配置就不再是唯一事实源，两边各说各话时用户看到的是界面那套，
 * 实际执行的是 descriptor 那套。
 *
 * 另一件必须做的是「提交之后按 descriptor 回校勾选」。`capabilityIds` 只能往上加：
 * 岗位包声明为可选依赖的能力由 resolver 自动展开，用户取消勾选再保存，它照样会回来。
 * 把这个差异算出来告诉用户，比让复选框自己弹回去要诚实得多。
 */

import type { PluginType } from '../enums';
import type { CampaignRuntimeView, SetRoleProfileInput } from '../ipc';
import type {
  ClientCapabilityMode,
  ClientCapabilityView,
  ClientPluginStatus,
  InstalledPlugin,
} from '../plugins/clientView';
import type { CampaignRuntimeDescriptor } from '../plugins/types';

export interface PluginOption {
  id: string;
  version: string;
  displayName: string;
  description: string;
}

/**
 * 级别取值。
 *
 * RoleProfile.level 是自由文本，任何岗位包都没有声明过级别词表；这里给的是跨岗位通用
 * 的资历档位，不含任何岗位专有说法，所以换成产品或销售岗位包也不需要改。
 */
export const ROLE_LEVEL_OPTIONS = ['实习', '初级', '中级', '高级', '资深', '专家', '管理'] as const;

export const INTERVIEW_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

export function listPluginOptions(
  installed: readonly InstalledPlugin[],
  type: PluginType,
): PluginOption[] {
  return installed
    .filter((plugin) => plugin.type === type)
    .map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      displayName: plugin.displayName,
      description: plugin.description,
    }))
    .sort((left, right) => (left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : 0));
}

export interface RoleProfileDraft {
  rolePackId: string;
  /** 空串表示不指定级别 */
  level: string;
  /** 空串表示不挂行业包 */
  industryPackId: string;
  location: string;
  interviewLanguage: string;
  /** 用户显式要求启用的能力插件 */
  capabilityIds: string[];
}

export function enabledCapabilityIds(descriptor: CampaignRuntimeDescriptor): string[] {
  return descriptor.capabilities
    .filter((capability) => capability.enabled)
    .map((capability) => capability.id)
    .sort();
}

/**
 * 表单初值。
 *
 * 没有 descriptor（旧库未回填、或者这场备考还没确认过岗位）时退回本机第一个岗位包，
 * 而不是留空：留空会让「确认」按钮永远不可用，用户也就没有任何办法把 descriptor 建起来。
 */
export function draftFromRuntime(
  runtime: CampaignRuntimeView | null,
  rolePackOptions: readonly PluginOption[],
): RoleProfileDraft {
  const profile = runtime?.roleProfile ?? null;
  const descriptor = runtime?.descriptor ?? null;
  return {
    rolePackId: profile?.rolePackId ?? descriptor?.rolePack.id ?? rolePackOptions[0]?.id ?? '',
    level: profile?.level ?? '',
    industryPackId: profile?.industryPackId ?? descriptor?.industryPack?.id ?? '',
    location: profile?.location ?? '',
    interviewLanguage: profile?.interviewLanguage ?? 'zh',
    capabilityIds: descriptor ? enabledCapabilityIds(descriptor) : [],
  };
}

/**
 * 表单 → IPC 入参。
 *
 * roleFamily 直接取岗位包 ID，不额外让用户填一个自由文本：这个字段的作用是把一场备考
 * 归到某一类岗位上，而「哪一类」已经由选中的岗位包定义了，再要一份手写值只会出现
 * 两者对不上的情况。userConfirmed 恒为 true——这条路径上的每一次写入都是用户按下确认。
 */
export function toSetRoleProfileInput(
  campaignId: string,
  draft: RoleProfileDraft,
): SetRoleProfileInput {
  return {
    campaignId,
    roleFamily: draft.rolePackId,
    rolePackId: draft.rolePackId,
    level: draft.level.trim() || null,
    industryPackId: draft.industryPackId || null,
    location: draft.location.trim() || null,
    interviewLanguage: draft.interviewLanguage,
    confidence: 1,
    userConfirmed: true,
    capabilityIds: [...draft.capabilityIds].sort(),
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

/** 未确认过的岗位也算「有待提交」，否则确认按钮会在自动识别的结果上一直是灰的 */
export function isDraftDirty(draft: RoleProfileDraft, runtime: CampaignRuntimeView | null): boolean {
  if (!runtime) return draft.rolePackId !== '';
  const profile = runtime.roleProfile;
  if (!profile?.userConfirmed) return true;
  return (
    profile.rolePackId !== draft.rolePackId ||
    (profile.level ?? '') !== draft.level ||
    (profile.industryPackId ?? '') !== draft.industryPackId ||
    (profile.location ?? '') !== draft.location ||
    profile.interviewLanguage !== draft.interviewLanguage ||
    !sameIds(enabledCapabilityIds(runtime.descriptor), draft.capabilityIds)
  );
}

export interface CapabilityReconciliation {
  /** 用户没勾却仍然启用：岗位包把它声明成了可选依赖，resolver 自动展开 */
  forcedOn: string[];
  /** 用户勾了但没能启用，附 resolver 给出的原因 */
  rejected: Array<{ id: string; reason: string }>;
}

export function reconcileCapabilitySelection(
  requested: readonly string[],
  descriptor: CampaignRuntimeDescriptor,
): CapabilityReconciliation {
  const asked = new Set(requested);
  const enabled = new Set(enabledCapabilityIds(descriptor));

  const forcedOn = [...enabled].filter((id) => !asked.has(id)).sort();
  const rejected = [...asked]
    .filter((id) => !enabled.has(id))
    .sort()
    .map((id) => {
      const ref = descriptor.capabilities.find((capability) => capability.id === id);
      return {
        id,
        reason:
          ref && !ref.enabled ? ref.disabledReason : '解析后没有进入运行配置，可能是版本不兼容',
      };
    });

  return { forcedOn, rejected };
}

export function reconciliationNotices(
  reconciliation: CapabilityReconciliation,
  displayName: (id: string) => string,
): string[] {
  return [
    ...reconciliation.forcedOn.map(
      (id) => `${displayName(id)}：岗位包把它声明为依赖，本次仍然启用，无法单独关闭`,
    ),
    ...reconciliation.rejected.map(({ id, reason }) => `${displayName(id)} 未能启用：${reason}`),
  ];
}

export interface CapabilityRow {
  id: string;
  displayName: string;
  /** descriptor 固定的精确版本；未进入运行配置时为 null */
  version: string | null;
  description: string;
  /** descriptor 是否为这场备考启用了它 */
  enabledInCampaign: boolean;
  /** descriptor 给出的停用原因 */
  disabledReason: string | null;
  /** 本机可用程度；没有 client view 时为 null */
  localMode: ClientCapabilityMode | null;
  /** 面向用户的降级说明 */
  localDetail: string | null;
  installedLocally: boolean;
}

/**
 * 能力插件清单 = descriptor 里的条目 ∪ 本机安装的能力插件。
 *
 * 两边都要取：只看 descriptor 会漏掉「本机装了但这场备考没启用」的插件，用户就没有
 * 入口把它加进来；只看本机清单会漏掉「descriptor 记着但本机没装」的插件，而那正是
 * 最需要显示出来的一种降级。
 */
export function buildCapabilityRows(input: {
  descriptor: CampaignRuntimeDescriptor | null;
  view: ClientCapabilityView | null;
  installed: readonly InstalledPlugin[];
}): CapabilityRow[] {
  const { descriptor, view, installed } = input;
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  const statusById = new Map<string, ClientPluginStatus>(
    (view?.capabilities ?? []).map((status) => [status.id, status]),
  );

  const ids = new Set<string>([
    ...(descriptor?.capabilities ?? []).map((capability) => capability.id),
    ...installed.filter((plugin) => plugin.type === 'capability').map((plugin) => plugin.id),
  ]);

  return [...ids].sort().map((id) => {
    const ref = descriptor?.capabilities.find((capability) => capability.id === id) ?? null;
    const status = statusById.get(id) ?? null;
    const plugin = installedById.get(id) ?? null;
    return {
      id,
      displayName: plugin?.displayName ?? id,
      version: ref?.version ?? null,
      description: plugin?.description ?? '',
      enabledInCampaign: ref?.enabled === true,
      disabledReason: ref && !ref.enabled ? ref.disabledReason : null,
      localMode: status?.mode ?? null,
      localDetail: status?.detail ?? null,
      installedLocally: plugin !== null,
    };
  });
}

export const CAPABILITY_MODE_LABELS: Record<ClientCapabilityMode, string> = {
  full: '可用',
  'view-only': '只读',
  unsupported: '不可用',
};

/** 岗位包 / 行业包本机状态的一句话说明；完全正常时为 null，界面不必显示 */
export function pluginStatusNotice(status: ClientPluginStatus | null): string | null {
  if (!status || status.mode === 'full') return null;
  return status.detail ?? CAPABILITY_MODE_LABELS[status.mode];
}
