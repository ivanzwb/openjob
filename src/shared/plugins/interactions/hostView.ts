/**
 * 宿主渲染决策。
 *
 * 桌面和手机共用这一个函数，所以「两端对同一 interaction schema 有一致降级行为」
 * 不是靠两套 UI 各自守规矩，而是结构上只有一处判断：两端的结果只可能因为
 * availability 与本机安装情况不同而不同，不可能因为渲染代码不同而不同。
 *
 * 输出是给薄壳的渲染指令，插件不参与渲染，也拿不到组件。
 */
import type { ClientCapabilityMode, ClientDegradationReason } from '../clientView';
import type { PluginPermission } from '../permissions';
import type { ClientPlatform, HostRenderedInteraction } from '../types';
import {
  collectUnknownFieldKinds,
  validateInteractionResultSchema,
  validateInteractionSchema,
  type InteractionChoiceOption,
  type InteractionField,
} from './schema';

/** 语音输入所需权限；撤销后回落为文字输入，不终止会话。 */
export const MICROPHONE_PERMISSION: PluginPermission = 'microphone:read';

interface RenderableBase {
  id: string;
  label: string;
}

export interface RenderableNote extends RenderableBase {
  kind: 'note';
}
export interface RenderableFactList extends RenderableBase {
  kind: 'factList';
}
export interface RenderableTranscript extends RenderableBase {
  kind: 'transcript';
}
export interface RenderableCountdown extends RenderableBase {
  kind: 'countdown';
  totalSeconds: number;
}
export interface RenderableReply extends RenderableBase {
  kind: 'reply';
  maxChars: number;
  /** 声明支持语音且本机已授权时才为 true。 */
  voiceEnabled: boolean;
  /** 语音不可用的原因说明；可用时为 null。 */
  voiceNotice: string | null;
}
export interface RenderableChoice extends RenderableBase {
  kind: 'choice';
  options: InteractionChoiceOption[];
}

export type RenderableInteractionField =
  | RenderableNote
  | RenderableFactList
  | RenderableTranscript
  | RenderableCountdown
  | RenderableReply
  | RenderableChoice;

export interface InteractionHostView {
  type: string;
  platform: ClientPlatform;
  mode: ClientCapabilityMode;
  /** 本机能否真正进行这个交互；false 时只允许查看历史结果。 */
  renderable: boolean;
  reason: ClientDegradationReason | null;
  /** 面向用户的降级说明；无降级时为 null。 */
  detail: string | null;
  /** 声明的交互版本。 */
  schemaVersion: number;
  /** 本机认识的交互版本；不认识为 null。 */
  knownSchemaVersion: number | null;
  /** renderable 为 false 时为空数组：不认识的东西一律不画。 */
  fields: RenderableInteractionField[];
  /** 必须回收的结果字段 ID。 */
  requiredResultFieldIds: string[];
}

export interface InteractionHostViewInput {
  interaction: HostRenderedInteraction;
  platform: ClientPlatform;
  /** descriptor 是否为本次 Campaign 启用了该能力。 */
  capabilityEnabled: boolean;
  /** 本机是否安装了提供该交互的插件。 */
  pluginInstalled: boolean;
  /** 本机安装版本声明的该交互类型版本；不认识为 null。 */
  knownSchemaVersion: number | null;
  /** 本机已授予的权限。 */
  grantedPermissions: readonly PluginPermission[];
}

const INTERACTION_DEGRADATION_DETAILS: Record<ClientDegradationReason, string> = {
  'capability-disabled': '本次 Campaign 未启用该交互',
  'plugin-not-installed': '本机未安装该交互所属插件，只能查看历史结果',
  'pinned-version-unavailable': '本机没有 Campaign 固定的插件版本，只能查看历史结果',
  'platform-view-only': '当前设备只支持查看该交互，需在桌面端进行',
  'platform-unsupported': '当前设备不支持该交互',
  'artifact-schema-unknown': '本机不认识该 artifact 的 schema 版本，只保留同步与查看',
  'interaction-schema-unknown': '本机不认识该交互的 schema 版本，只保留同步与查看',
};

function projectField(
  field: InteractionField,
  voiceGranted: boolean,
): RenderableInteractionField {
  switch (field.kind) {
    case 'countdown':
      return { id: field.id, label: field.label, kind: 'countdown', totalSeconds: field.totalSeconds };
    case 'reply': {
      const voiceEnabled = field.voiceCapable && voiceGranted;
      return {
        id: field.id,
        label: field.label,
        kind: 'reply',
        maxChars: field.maxChars,
        voiceEnabled,
        voiceNotice: field.voiceCapable && !voiceGranted ? '麦克风不可用，本轮改为文字作答' : null,
      };
    }
    case 'choice':
      return { id: field.id, label: field.label, kind: 'choice', options: [...field.options] };
    default:
      return { id: field.id, label: field.label, kind: field.kind };
  }
}

function degraded(
  input: InteractionHostViewInput,
  mode: ClientCapabilityMode,
  reason: ClientDegradationReason,
): InteractionHostView {
  return {
    type: input.interaction.type,
    platform: input.platform,
    mode,
    renderable: false,
    reason,
    detail: INTERACTION_DEGRADATION_DETAILS[reason],
    schemaVersion: input.interaction.schemaVersion,
    knownSchemaVersion: input.knownSchemaVersion,
    fields: [],
    requiredResultFieldIds: [],
  };
}

/**
 * 计算本机对某个交互的渲染能力。
 *
 * 判断顺序按严重程度从高到低，先命中的原因即为最终原因，
 * 保证同一输入在两端得到同一条降级理由。
 */
export function buildInteractionHostView(input: InteractionHostViewInput): InteractionHostView {
  const { interaction, platform } = input;

  if (!input.capabilityEnabled) return degraded(input, 'unsupported', 'capability-disabled');
  if (!input.pluginInstalled) return degraded(input, 'view-only', 'plugin-not-installed');

  const availability = interaction.availability[platform];
  if (availability === 'unsupported') return degraded(input, 'unsupported', 'platform-unsupported');
  if (availability === 'view-only') return degraded(input, 'view-only', 'platform-view-only');

  // 对端可能来自更新的版本：声明版本高于本机认识的版本就不渲染。
  if (input.knownSchemaVersion === null || interaction.schemaVersion > input.knownSchemaVersion) {
    return degraded(input, 'view-only', 'interaction-schema-unknown');
  }

  // 结构不合法或含本机不认识的字段类型时同样降级，绝不半渲染。
  const schemaIssues = validateInteractionSchema(interaction.inputSchema);
  const resultIssues = validateInteractionResultSchema(
    interaction.resultSchema,
    interaction.inputSchema,
  );
  if (schemaIssues.length > 0 || resultIssues.length > 0) {
    return degraded(input, 'view-only', 'interaction-schema-unknown');
  }

  const voiceGranted = input.grantedPermissions.includes(MICROPHONE_PERMISSION);
  return {
    type: interaction.type,
    platform,
    mode: 'full',
    renderable: true,
    reason: null,
    detail: null,
    schemaVersion: interaction.schemaVersion,
    knownSchemaVersion: input.knownSchemaVersion,
    fields: interaction.inputSchema.fields.map((field) => projectField(field, voiceGranted)),
    requiredResultFieldIds: interaction.resultSchema.fields
      .filter((field) => field.required)
      .map((field) => field.id)
      .sort(),
  };
}

/** 供降级提示复用；与 clientView 的文案风格保持一致。 */
export function interactionDegradationDetail(reason: ClientDegradationReason): string {
  return INTERACTION_DEGRADATION_DETAILS[reason];
}

/** 不认识的字段类型清单；用于提示与诊断。 */
export function unknownFieldKinds(interaction: HostRenderedInteraction): string[] {
  return collectUnknownFieldKinds(interaction.inputSchema);
}
