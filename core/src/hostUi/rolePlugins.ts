/**
 * 岗位与能力选择的取数与写回。
 *
 * 界面上要回答三个问题：这场备考挂的是哪个岗位包、级别是什么、哪些能力在生效。
 * 三个答案全部来自 descriptor 与本机安装清单，没有一处从 `campaign.roleTitle` 之类的
 * 岗位标题文本猜出来——一旦界面开始自己判断「标题里有 backend 就按工程岗渲染」，
 * resolver 解析出的那份配置就不再是唯一事实源，两边各说各话时用户看到的是界面那套，
 * 实际执行的是 descriptor 那套。
 *
 * 界面不做「回校」也不回显回执：`capabilityIds` 只是按 descriptor 回填、原样写回，
 * 岗位包声明为可选依赖的能力由 resolver 自动展开，解析结果直接反映在 descriptor 上。
 */

import type { PluginType } from '../enums';
import type { CampaignRuntimeView, SetRoleProfileInput } from '../ipc';
import type {
  ClientCapabilityMode,
  ClientPluginStatus,
  InstalledPlugin,
} from '../plugins/clientView';
import type { CampaignRuntimeDescriptor, IndustryVariant } from '../plugins/types';

export interface PluginOption {
  id: string;
  version: string;
  displayName: string;
  description: string;
  /** 岗位包声明的行业差异变体；其他类型与没声明的包为空 */
  industryVariants?: IndustryVariant[];
}

/**
 * 级别取值。
 *
 * RoleProfile.level 是自由文本，任何岗位包都没有声明过级别词表；这里给的是跨岗位通用
 * 的资历档位，不含任何岗位专有说法，所以换成产品或销售岗位包也不需要改。
 */
export const ROLE_LEVEL_OPTIONS = ['实习', '初级', '中级', '高级', '资深', '专家', '管理'] as const;

/**
 * 没写过级别时的默认档位。
 *
 * 级别会进 prompt 影响出题与评分口径，留空等于把口径交给模型自由发挥；`中级` 是这套档位
 * 的中位取值（也是绝大多数备考者的实际区间），对任何岗位包都成立，所以放在基础包。
 */
export const DEFAULT_ROLE_LEVEL = '中级';

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
      ...(plugin.industryVariants && plugin.industryVariants.length > 0
        ? { industryVariants: plugin.industryVariants }
        : {}),
    }))
    .sort((left, right) => (left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : 0));
}

export interface RoleProfileDraft {
  rolePackId: string;
  /** 没写过就是默认档位；用户仍可选「不指定」把它清空 */
  level: string;
  /** 空串表示不选行业变体（岗位包没声明变体时它一直是空串） */
  industryVariantId: string;
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
 * 没有 descriptor（旧库未回填、或者这场备考还没挑过岗位包）时退回本机第一个岗位包，
 * 而不是留空：留空会让用户没有任何办法把 descriptor 建起来。这个默认值本身不触发
 * 写入——只有用户真的改动了面板才算选择，见 RolePluginPanel 的「用户是否动过」把关。
 */
export function draftFromRuntime(
  runtime: CampaignRuntimeView | null,
  rolePackOptions: readonly PluginOption[],
): RoleProfileDraft {
  const profile = runtime?.roleProfile ?? null;
  const descriptor = runtime?.descriptor ?? null;
  return {
    rolePackId: profile?.rolePackId ?? descriptor?.rolePack.id ?? rolePackOptions[0]?.id ?? '',
    level: profile?.level || DEFAULT_ROLE_LEVEL,
    industryVariantId: profile?.industryVariantId ?? descriptor?.industryVariantId ?? '',
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
 * 两者对不上的情况。userConfirmed 恒为 true——这条路径上的每一次写入都由用户自己挑的
 * 选项触发，用户的选择本身就是确认，不必再要一次显式确认。
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
    industryVariantId: draft.industryVariantId || null,
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

/**
 * 草稿与当前生效配置是否已经不一致。
 *
 * 只看值本身，不再看 userConfirmed：面板改成「选中即生效」之后，一次选择写完就落成
 * 配置，确认与否不再是一条要用户补上的步骤。若还按 userConfirmed 判脏，读路径自动
 * 解析出的那份未确认配置会让表单一直「有待提交」，防抖写入便会无休止地重跑。
 *
 * 没有 descriptor（旧库未回填、或这场备考还没挑过岗位包）时，选了岗位包就算有待写入：
 * 否则用户没有任何办法把这份配置建起来。调用方要避免「仅打开面板就把默认岗位包写进去」，
 * 那是调用方按「用户是否动过」把关，不是这里凭空判脏。
 */
export function isDraftDirty(draft: RoleProfileDraft, runtime: CampaignRuntimeView | null): boolean {
  if (!runtime) return draft.rolePackId !== '';
  const profile = runtime.roleProfile;
  const descriptor = runtime.descriptor;
  return (
    (profile?.rolePackId ?? descriptor.rolePack.id) !== draft.rolePackId ||
    (profile?.level ?? '') !== draft.level ||
    (profile?.industryVariantId ?? '') !== draft.industryVariantId ||
    (profile?.location ?? '') !== draft.location ||
    (profile?.interviewLanguage ?? 'zh') !== draft.interviewLanguage ||
    !sameIds(enabledCapabilityIds(descriptor), draft.capabilityIds)
  );
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
