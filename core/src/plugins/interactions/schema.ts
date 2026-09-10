/**
 * 宿主渲染交互的字段协议。
 *
 * 这里刻意**不使用任意 JSON Schema**。任意 schema 无法保证宿主渲染得出来，
 * 最终一定要给插件开一个「自带组件」的逃逸口，那么「插件不注入任意 React 组件」
 * 这条约束就形同虚设。因此字段类型集由 Core 拥有并封闭：插件只能从下表里挑，
 * 宿主对每一种都有确定的渲染方式；遇到不认识的类型一律降级，不猜测、不执行插件代码。
 *
 * 两个版本轴不要混淆：
 * - INTERACTION_PROTOCOL_VERSION：字段协议本身的版本，Core 拥有；
 * - HostRenderedInteraction.schemaVersion：某个交互类型的版本，插件拥有。
 */

/** 字段协议版本；新增字段类型属于向后兼容的小版本，删除类型必须升大版本。 */
export const INTERACTION_PROTOCOL_VERSION = 1;

/**
 * 只读展示类字段：宿主渲染，候选人不能编辑。
 * 值由运行时提供，schema 只声明结构与配置。
 */
export const INTERACTION_DISPLAY_KINDS = ['note', 'factList', 'transcript', 'countdown'] as const;

/** 可输入字段：宿主渲染控件并回收候选人输入。 */
export const INTERACTION_INPUT_KINDS = ['reply', 'choice'] as const;

export const INTERACTION_FIELD_KINDS = [
  ...INTERACTION_DISPLAY_KINDS,
  ...INTERACTION_INPUT_KINDS,
] as const;

export type InteractionDisplayKind = (typeof INTERACTION_DISPLAY_KINDS)[number];
export type InteractionInputKind = (typeof INTERACTION_INPUT_KINDS)[number];
export type InteractionFieldKind = (typeof INTERACTION_FIELD_KINDS)[number];

export function isInteractionFieldKind(value: unknown): value is InteractionFieldKind {
  return typeof value === 'string' && (INTERACTION_FIELD_KINDS as readonly string[]).includes(value);
}

export function isInteractionInputKind(value: unknown): value is InteractionInputKind {
  return typeof value === 'string' && (INTERACTION_INPUT_KINDS as readonly string[]).includes(value);
}

interface InteractionFieldBase {
  /** 交互内稳定 ID；运行时按此 ID 提供值、回收输入。 */
  id: string;
  label: string;
}

/** 一段只读说明文字，例如场景交代。 */
export interface InteractionNoteField extends InteractionFieldBase {
  kind: 'note';
}

/** 只读键值表，例如客户人设卡。 */
export interface InteractionFactListField extends InteractionFieldBase {
  kind: 'factList';
}

/** 只读对话记录。 */
export interface InteractionTranscriptField extends InteractionFieldBase {
  kind: 'transcript';
}

/** 只读倒计时；总时长是 schema 级配置，剩余时间由运行时提供。 */
export interface InteractionCountdownField extends InteractionFieldBase {
  kind: 'countdown';
  totalSeconds: number;
}

/** 多行文本输入。voiceCapable 只表示「可以用语音」，宿主没有麦克风权限时照样能打字。 */
export interface InteractionReplyField extends InteractionFieldBase {
  kind: 'reply';
  maxChars: number;
  voiceCapable: boolean;
}

export interface InteractionChoiceOption {
  value: string;
  label: string;
}

/** 单选。 */
export interface InteractionChoiceField extends InteractionFieldBase {
  kind: 'choice';
  options: InteractionChoiceOption[];
}

export type InteractionField =
  | InteractionNoteField
  | InteractionFactListField
  | InteractionTranscriptField
  | InteractionCountdownField
  | InteractionReplyField
  | InteractionChoiceField;

export interface InteractionSchema {
  /** 该交互所依据的字段协议版本。 */
  protocolVersion: number;
  fields: InteractionField[];
}

export const INTERACTION_RESULT_VALUE_TYPES = ['text', 'choice'] as const;
export type InteractionResultValueType = (typeof INTERACTION_RESULT_VALUE_TYPES)[number];

/**
 * 结果字段。
 *
 * 每个结果字段必须对应 inputSchema 里的一个可输入字段：
 * 宿主不可能返回它从未渲染过的东西。
 */
export interface InteractionResultField {
  id: string;
  valueType: InteractionResultValueType;
  required: boolean;
}

export interface InteractionResultSchema {
  protocolVersion: number;
  fields: InteractionResultField[];
}

/** 可输入字段类型 → 结果值类型的固定映射。 */
export const INPUT_KIND_RESULT_TYPE: Record<InteractionInputKind, InteractionResultValueType> = {
  reply: 'text',
  choice: 'choice',
};

export type InteractionSchemaIssueCode =
  | 'invalid-value'
  | 'invalid-id'
  | 'duplicate-id'
  | 'unknown-field-kind'
  | 'unsupported-protocol'
  | 'no-input-field'
  | 'missing-reference'
  | 'type-mismatch';

export interface InteractionSchemaIssue {
  path: string;
  code: InteractionSchemaIssueCode;
  message: string;
}

const FIELD_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function issue(
  issues: InteractionSchemaIssue[],
  path: string,
  code: InteractionSchemaIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateField(value: unknown, path: string, issues: InteractionSchemaIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, 'invalid-value', '字段必须是对象');
    return;
  }

  if (!isNonEmptyString(value.id) || !FIELD_ID_PATTERN.test(value.id)) {
    issue(issues, `${path}.id`, 'invalid-id', '字段 ID 必须是小写连字符形式');
  }
  if (!isNonEmptyString(value.label)) {
    issue(issues, `${path}.label`, 'invalid-value', '字段缺少 label');
  }

  // 不认识的字段类型不是「非法」而是「本机渲染不了」，交由降级逻辑处理，
  // 但仍记为 issue，避免注册期把未来类型混进内置插件。
  if (!isInteractionFieldKind(value.kind)) {
    issue(issues, `${path}.kind`, 'unknown-field-kind', `本机不认识的字段类型：${String(value.kind)}`);
    return;
  }

  if (value.kind === 'countdown') {
    if (!Number.isInteger(value.totalSeconds) || (value.totalSeconds as number) < 1) {
      issue(issues, `${path}.totalSeconds`, 'invalid-value', '倒计时总时长必须是正整数秒');
    }
  }

  if (value.kind === 'reply') {
    if (!Number.isInteger(value.maxChars) || (value.maxChars as number) < 1) {
      issue(issues, `${path}.maxChars`, 'invalid-value', '回答长度上限必须是正整数');
    }
    if (typeof value.voiceCapable !== 'boolean') {
      issue(issues, `${path}.voiceCapable`, 'invalid-value', 'voiceCapable 必须是布尔值');
    }
  }

  if (value.kind === 'choice') {
    const options = value.options;
    if (!Array.isArray(options) || options.length < 2) {
      issue(issues, `${path}.options`, 'invalid-value', '单选至少需要两个选项');
      return;
    }
    const seen = new Set<string>();
    options.forEach((option, index) => {
      const optionPath = `${path}.options[${index}]`;
      if (!isRecord(option)) {
        issue(issues, optionPath, 'invalid-value', '选项必须是对象');
        return;
      }
      if (!isNonEmptyString(option.value)) {
        issue(issues, `${optionPath}.value`, 'invalid-value', '选项缺少 value');
        return;
      }
      if (seen.has(option.value)) {
        issue(issues, `${optionPath}.value`, 'duplicate-id', `选项重复：${option.value}`);
      }
      seen.add(option.value);
      if (!isNonEmptyString(option.label)) {
        issue(issues, `${optionPath}.label`, 'invalid-value', '选项缺少 label');
      }
    });
  }
}

/**
 * 校验输入 schema 的结构。
 *
 * 接受 unknown：schema 也可能来自更新版本的对端同步数据，不能假设已是合法类型。
 */
export function validateInteractionSchema(value: unknown): InteractionSchemaIssue[] {
  const issues: InteractionSchemaIssue[] = [];
  if (!isRecord(value)) {
    issue(issues, 'schema', 'invalid-value', 'schema 必须是对象');
    return issues;
  }

  if (!Number.isInteger(value.protocolVersion) || (value.protocolVersion as number) < 1) {
    issue(issues, 'schema.protocolVersion', 'invalid-value', '协议版本必须是正整数');
  } else if ((value.protocolVersion as number) > INTERACTION_PROTOCOL_VERSION) {
    issue(
      issues,
      'schema.protocolVersion',
      'unsupported-protocol',
      `本机字段协议版本为 ${INTERACTION_PROTOCOL_VERSION}，无法渲染 ${value.protocolVersion}`,
    );
  }

  const fields = value.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    issue(issues, 'schema.fields', 'invalid-value', 'schema 至少需要一个字段');
    return issues;
  }

  const ids = new Set<string>();
  let inputCount = 0;
  fields.forEach((field, index) => {
    const path = `schema.fields[${index}]`;
    validateField(field, path, issues);
    if (!isRecord(field)) return;
    if (typeof field.id === 'string') {
      if (ids.has(field.id)) {
        issue(issues, `${path}.id`, 'duplicate-id', `字段 ID 重复：${field.id}`);
      }
      ids.add(field.id);
    }
    if (isInteractionInputKind(field.kind)) inputCount += 1;
  });

  if (inputCount === 0) {
    issue(issues, 'schema.fields', 'no-input-field', '交互至少需要一个可输入字段');
  }

  return issues;
}

/**
 * 校验结果 schema，并与输入 schema 交叉核对。
 *
 * 交叉核对是这套协议的关键不变量：结果字段必须来自输入 schema 里真实渲染过的
 * 可输入字段，且值类型由字段类型唯一决定，插件无法自定义。
 */
export function validateInteractionResultSchema(
  value: unknown,
  inputSchema: unknown,
): InteractionSchemaIssue[] {
  const issues: InteractionSchemaIssue[] = [];
  if (!isRecord(value)) {
    issue(issues, 'resultSchema', 'invalid-value', 'resultSchema 必须是对象');
    return issues;
  }

  if (!Number.isInteger(value.protocolVersion) || (value.protocolVersion as number) < 1) {
    issue(issues, 'resultSchema.protocolVersion', 'invalid-value', '协议版本必须是正整数');
  } else if ((value.protocolVersion as number) > INTERACTION_PROTOCOL_VERSION) {
    issue(
      issues,
      'resultSchema.protocolVersion',
      'unsupported-protocol',
      `本机字段协议版本为 ${INTERACTION_PROTOCOL_VERSION}，无法读取 ${value.protocolVersion}`,
    );
  }

  const inputKinds = new Map<string, InteractionInputKind>();
  if (isRecord(inputSchema) && Array.isArray(inputSchema.fields)) {
    for (const field of inputSchema.fields) {
      if (!isRecord(field) || typeof field.id !== 'string') continue;
      if (isInteractionInputKind(field.kind)) inputKinds.set(field.id, field.kind);
    }
  }

  const fields = value.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    issue(issues, 'resultSchema.fields', 'invalid-value', 'resultSchema 至少需要一个字段');
    return issues;
  }

  const ids = new Set<string>();
  fields.forEach((field, index) => {
    const path = `resultSchema.fields[${index}]`;
    if (!isRecord(field)) {
      issue(issues, path, 'invalid-value', '结果字段必须是对象');
      return;
    }
    if (!isNonEmptyString(field.id)) {
      issue(issues, `${path}.id`, 'invalid-id', '结果字段缺少 ID');
      return;
    }
    if (ids.has(field.id)) {
      issue(issues, `${path}.id`, 'duplicate-id', `结果字段 ID 重复：${field.id}`);
    }
    ids.add(field.id);

    if (typeof field.required !== 'boolean') {
      issue(issues, `${path}.required`, 'invalid-value', 'required 必须是布尔值');
    }

    const inputKind = inputKinds.get(field.id);
    if (!inputKind) {
      issue(
        issues,
        `${path}.id`,
        'missing-reference',
        `结果字段 ${field.id} 在输入 schema 里没有对应的可输入字段`,
      );
      return;
    }

    const expected = INPUT_KIND_RESULT_TYPE[inputKind];
    if (field.valueType !== expected) {
      issue(
        issues,
        `${path}.valueType`,
        'type-mismatch',
        `字段 ${field.id} 为 ${inputKind}，结果类型必须是 ${expected}`,
      );
    }
  });

  return issues;
}

export type InteractionResultValue = Record<string, string | undefined>;

export interface InteractionResultValueIssue {
  fieldId: string;
  code: 'missing-required' | 'unknown-field' | 'too-long' | 'not-an-option' | 'invalid-value';
  message: string;
}

/**
 * 按 resultSchema 校验宿主交回的数据。
 *
 * 与结构校验相对：结构校验管「插件能声明什么」，这里管「运行期真的收到了什么」。
 * 未在 schema 里出现的字段一律拒绝，避免宿主或调用方偷偷塞进额外内容。
 */
export function validateInteractionResultValue(
  resultSchema: InteractionResultSchema,
  inputSchema: InteractionSchema,
  value: InteractionResultValue,
): InteractionResultValueIssue[] {
  const issues: InteractionResultValueIssue[] = [];
  const declared = new Set(resultSchema.fields.map((field) => field.id));

  for (const fieldId of Object.keys(value)) {
    if (!declared.has(fieldId)) {
      issues.push({
        fieldId,
        code: 'unknown-field',
        message: `结果字段未在 resultSchema 中声明：${fieldId}`,
      });
    }
  }

  const inputById = new Map(inputSchema.fields.map((field) => [field.id, field]));

  for (const field of resultSchema.fields) {
    const raw = value[field.id];
    const filled = typeof raw === 'string' && raw.trim().length > 0;

    if (!filled) {
      if (field.required) {
        issues.push({
          fieldId: field.id,
          code: 'missing-required',
          message: `缺少必填结果字段：${field.id}`,
        });
      }
      continue;
    }

    const input = inputById.get(field.id);
    if (input?.kind === 'reply' && raw.length > input.maxChars) {
      issues.push({
        fieldId: field.id,
        code: 'too-long',
        message: `${field.id} 超出长度上限 ${input.maxChars}`,
      });
    }
    if (input?.kind === 'choice' && !input.options.some((option) => option.value === raw)) {
      issues.push({
        fieldId: field.id,
        code: 'not-an-option',
        message: `${field.id} 不是已渲染的选项：${raw}`,
      });
    }
  }

  return issues;
}

/** 收集 schema 里本机不认识的字段类型；用于降级判断而非报错。 */
export function collectUnknownFieldKinds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.fields)) return [];
  const unknown = new Set<string>();
  for (const field of value.fields) {
    if (!isRecord(field)) continue;
    if (!isInteractionFieldKind(field.kind)) unknown.add(String(field.kind));
  }
  return [...unknown].sort();
}
