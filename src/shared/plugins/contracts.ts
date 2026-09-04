import {
  COMPETENCY_CATEGORIES,
  FOLLOW_UP_STRATEGIES,
  INTERVIEW_PROTOCOLS,
  PLUGIN_TYPES,
  RUNTIME_AVAILABILITIES,
} from '../enums';
import { isPluginPermission } from './permissions';
import type {
  CapabilityPlugin,
  PluginManifest,
  PromptFragmentSet,
  RolePack,
  RubricAnchors,
} from './types';

export interface PluginContractIssue {
  path: string;
  code:
    | 'invalid-value'
    | 'invalid-id'
    | 'invalid-version'
    | 'duplicate-id'
    | 'missing-reference'
    | 'invalid-permission'
    | 'invalid-weight'
    | 'invalid-anchor'
    | 'invalid-prompt-slot';
  message: string;
}

export class PluginContractError extends Error {
  readonly issues: PluginContractIssue[];

  constructor(issues: PluginContractIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'PluginContractError';
    this.issues = issues;
  }
}

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SEMVER_RANGE_CHARS_RE = /^[0-9A-Za-z.*+<>=~^|\s-]+$/;
const PROMPT_SLOTS = [
  'diagnosis',
  'explanation',
  'questionGeneration',
  'scoring',
  'answerCoaching',
  'debrief',
] as const satisfies ReadonlyArray<keyof PromptFragmentSet>;

function issue(
  issues: PluginContractIssue[],
  path: string,
  code: PluginContractIssue['code'],
  message: string,
): void {
  issues.push({ path, code, message });
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isStablePluginId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function isExactSemVer(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_RE.test(value);
}

/**
 * T01 只校验范围语法，T02 再负责实际 SemVer 匹配与最高兼容版本选择。
 */
export function isSemVerRange(value: unknown): value is string {
  if (!isNonEmpty(value) || !SEMVER_RANGE_CHARS_RE.test(value)) return false;
  const trimmed = value.trim();
  if (trimmed === '*') return true;
  return /\d+(?:\.(?:\d+|x|X|\*)){0,2}/.test(trimmed);
}

function validateUniqueIds(
  values: ReadonlyArray<{ id: string }>,
  path: string,
  issues: PluginContractIssue[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const itemPath = `${path}[${index}].id`;
    if (!isStablePluginId(value.id)) issue(issues, itemPath, 'invalid-id', '必须是稳定的小写 ID');
    if (seen.has(value.id)) issue(issues, itemPath, 'duplicate-id', `重复 ID：${value.id}`);
    seen.add(value.id);
  });
}

function validateWeightTotal(
  values: ReadonlyArray<{ weight: number }>,
  path: string,
  issues: PluginContractIssue[],
): void {
  values.forEach((value, index) => {
    if (!Number.isFinite(value.weight) || value.weight <= 0 || value.weight > 1) {
      issue(issues, `${path}[${index}].weight`, 'invalid-weight', '权重必须在 (0, 1] 内');
    }
  });
  const total = values.reduce((sum, value) => sum + value.weight, 0);
  if (values.length > 0 && Math.abs(total - 1) > 1e-6) {
    issue(issues, path, 'invalid-weight', `权重总和必须为 1，当前为 ${total}`);
  }
}

export function validatePluginManifest(manifest: PluginManifest): PluginContractIssue[] {
  const issues: PluginContractIssue[] = [];
  if (!isStablePluginId(manifest.id)) issue(issues, 'manifest.id', 'invalid-id', '必须是稳定的小写 ID');
  if (!isExactSemVer(manifest.version)) {
    issue(issues, 'manifest.version', 'invalid-version', '必须是精确 SemVer');
  }
  if (!(PLUGIN_TYPES as readonly string[]).includes(manifest.type)) {
    issue(issues, 'manifest.type', 'invalid-value', '未知插件类型');
  }
  if (!isNonEmpty(manifest.displayName)) {
    issue(issues, 'manifest.displayName', 'invalid-value', '显示名称不能为空');
  }
  if (!isNonEmpty(manifest.description)) {
    issue(issues, 'manifest.description', 'invalid-value', '描述不能为空');
  }
  if (!isSemVerRange(manifest.compatibility?.core)) {
    issue(issues, 'manifest.compatibility.core', 'invalid-version', '必须是合法 SemVer 范围');
  }
  if (
    !Number.isInteger(manifest.compatibility?.schema) ||
    manifest.compatibility.schema < 0
  ) {
    issue(issues, 'manifest.compatibility.schema', 'invalid-value', 'schema 必须是非负整数');
  }

  const permissionSet = new Set<string>();
  (manifest.permissions ?? []).forEach((permission, index) => {
    if (!isPluginPermission(permission)) {
      issue(issues, `manifest.permissions[${index}]`, 'invalid-permission', '未知插件权限');
    }
    if (permissionSet.has(permission)) {
      issue(issues, `manifest.permissions[${index}]`, 'duplicate-id', `重复权限：${permission}`);
    }
    permissionSet.add(permission);
  });
  if (manifest.type !== 'capability' && (manifest.permissions?.length ?? 0) > 0) {
    issue(
      issues,
      'manifest.permissions',
      'invalid-permission',
      'Role/Industry Pack 不得申请执行权限',
    );
  }

  if (manifest.type === 'capability' && !manifest.runtime) {
    issue(issues, 'manifest.runtime', 'invalid-value', 'Capability 必须声明双端运行能力');
  }
  if (manifest.runtime) {
    (['desktop', 'mobile'] as const).forEach((platform) => {
      if (!(RUNTIME_AVAILABILITIES as readonly string[]).includes(manifest.runtime![platform])) {
        issue(issues, `manifest.runtime.${platform}`, 'invalid-value', '未知运行能力');
      }
    });
  }

  const dependencyIds = new Set<string>();
  (manifest.dependencies ?? []).forEach((dependency, index) => {
    const path = `manifest.dependencies[${index}]`;
    if (!isStablePluginId(dependency.id)) {
      issue(issues, `${path}.id`, 'invalid-id', '依赖 ID 不合法');
    }
    if (dependency.id === manifest.id) {
      issue(issues, `${path}.id`, 'invalid-value', '插件不能依赖自身');
    }
    if (dependencyIds.has(dependency.id)) {
      issue(issues, `${path}.id`, 'duplicate-id', `重复依赖：${dependency.id}`);
    }
    dependencyIds.add(dependency.id);
    if (!isSemVerRange(dependency.version)) {
      issue(issues, `${path}.version`, 'invalid-version', '依赖版本必须是 SemVer 范围');
    }
  });

  Object.entries(manifest.artifactSchemas ?? {}).forEach(([artifactType, version]) => {
    if (!isStablePluginId(artifactType)) {
      issue(issues, `manifest.artifactSchemas.${artifactType}`, 'invalid-id', 'artifact type 不合法');
    }
    if (!Number.isInteger(version) || version < 1) {
      issue(
        issues,
        `manifest.artifactSchemas.${artifactType}`,
        'invalid-value',
        'artifact schema 版本必须是正整数',
      );
    }
  });

  return issues;
}

function validatePromptFragments(
  fragments: PromptFragmentSet,
  formatIds: Set<string>,
  issues: PluginContractIssue[],
): void {
  Object.keys(fragments).forEach((slot) => {
    if (!(PROMPT_SLOTS as readonly string[]).includes(slot)) {
      issue(issues, `promptFragments.${slot}`, 'invalid-prompt-slot', '不允许的 Prompt Slot');
    }
  });

  (['diagnosis', 'explanation', 'debrief'] as const).forEach((slot) => {
    const value = fragments[slot];
    if (value !== undefined && !isNonEmpty(value)) {
      issue(issues, `promptFragments.${slot}`, 'invalid-value', 'Prompt fragment 不能为空');
    }
  });

  (['questionGeneration', 'scoring', 'answerCoaching'] as const).forEach((slot) => {
    Object.entries(fragments[slot] ?? {}).forEach(([formatId, value]) => {
      if (!formatIds.has(formatId)) {
        issue(
          issues,
          `promptFragments.${slot}.${formatId}`,
          'missing-reference',
          '引用了未定义的面试形式',
        );
      }
      if (!isNonEmpty(value)) {
        issue(issues, `promptFragments.${slot}.${formatId}`, 'invalid-value', 'Prompt fragment 不能为空');
      }
    });
  });
}

function validateAnchors(
  anchors: RubricAnchors,
  path: string,
  issues: PluginContractIssue[],
): void {
  ([1, 2, 3, 4, 5] as const).forEach((score) => {
    if (!isNonEmpty(anchors?.[score])) {
      issue(issues, `${path}.${score}`, 'invalid-anchor', `${score} 分必须有可观察行为锚点`);
    }
  });
}

export function validateRolePack(pack: RolePack): PluginContractIssue[] {
  const issues = validatePluginManifest(pack.manifest);
  if (pack.manifest.type !== 'role-pack') {
    issue(issues, 'manifest.type', 'invalid-value', 'RolePack 的 manifest.type 必须是 role-pack');
  }

  validateUniqueIds(pack.competencyTemplates, 'competencyTemplates', issues);
  validateUniqueIds(pack.interviewStages, 'interviewStages', issues);
  validateUniqueIds(pack.interviewFormats, 'interviewFormats', issues);
  validateUniqueIds(pack.rubrics, 'rubrics', issues);
  validateUniqueIds(pack.taskTemplates, 'taskTemplates', issues);

  const formatIds = new Set(pack.interviewFormats.map((format) => format.id));
  const rubricIds = new Set(pack.rubrics.map((rubric) => rubric.id));

  pack.roleMatchers.forEach((matcher, matcherIndex) => {
    if (matcher.titlePatterns.length === 0) {
      issue(
        issues,
        `roleMatchers[${matcherIndex}].titlePatterns`,
        'invalid-value',
        '至少需要一个岗位标题匹配规则',
      );
    }
    matcher.titlePatterns.forEach((pattern, patternIndex) => {
      try {
        new RegExp(pattern, 'i');
      } catch {
        issue(
          issues,
          `roleMatchers[${matcherIndex}].titlePatterns[${patternIndex}]`,
          'invalid-value',
          '不是合法正则',
        );
      }
    });
  });

  validateWeightTotal(
    pack.competencyTemplates.map((template) => ({ weight: template.defaultWeight })),
    'competencyTemplates',
    issues,
  );
  pack.competencyTemplates.forEach((template, index) => {
    const path = `competencyTemplates[${index}]`;
    if (!(COMPETENCY_CATEGORIES as readonly string[]).includes(template.category)) {
      issue(issues, `${path}.category`, 'invalid-value', '未知能力分类');
    }
    if (!isNonEmpty(template.name) || !isNonEmpty(template.description)) {
      issue(issues, path, 'invalid-value', '能力名称和描述不能为空');
    }
    const levels = new Set<number>();
    template.levelIndicators.forEach((indicator, levelIndex) => {
      if (
        !Number.isInteger(indicator.level) ||
        indicator.level < 1 ||
        indicator.level > 5 ||
        levels.has(indicator.level)
      ) {
        issue(
          issues,
          `${path}.levelIndicators[${levelIndex}].level`,
          'invalid-value',
          '等级必须是 1–5 的唯一整数',
        );
      }
      levels.add(indicator.level);
      if (!isNonEmpty(indicator.behavior)) {
        issue(
          issues,
          `${path}.levelIndicators[${levelIndex}].behavior`,
          'invalid-value',
          '等级行为不能为空',
        );
      }
    });
    template.supportedFormats.forEach((formatId, formatIndex) => {
      if (!formatIds.has(formatId)) {
        issue(
          issues,
          `${path}.supportedFormats[${formatIndex}]`,
          'missing-reference',
          `面试形式不存在：${formatId}`,
        );
      }
    });
  });

  validateWeightTotal(
    pack.interviewStages.map((stage) => ({ weight: stage.defaultWeight })),
    'interviewStages',
    issues,
  );
  pack.interviewStages.forEach((stage, index) => {
    if (!Number.isInteger(stage.order) || stage.order < 0) {
      issue(issues, `interviewStages[${index}].order`, 'invalid-value', '顺序必须是非负整数');
    }
    stage.formatIds.forEach((formatId, formatIndex) => {
      if (!formatIds.has(formatId)) {
        issue(
          issues,
          `interviewStages[${index}].formatIds[${formatIndex}]`,
          'missing-reference',
          `面试形式不存在：${formatId}`,
        );
      }
    });
  });

  pack.interviewFormats.forEach((format, index) => {
    const path = `interviewFormats[${index}]`;
    if (!(INTERVIEW_PROTOCOLS as readonly string[]).includes(format.protocol)) {
      issue(issues, `${path}.protocol`, 'invalid-value', '未知面试协议');
    }
    if (!Number.isFinite(format.defaultDurationMinutes) || format.defaultDurationMinutes <= 0) {
      issue(issues, `${path}.defaultDurationMinutes`, 'invalid-value', '时长必须大于 0');
    }
    if (
      !Number.isInteger(format.followUpPolicy.maxRounds) ||
      format.followUpPolicy.maxRounds < 0
    ) {
      issue(issues, `${path}.followUpPolicy.maxRounds`, 'invalid-value', '追问轮数必须是非负整数');
    }
    if (!(FOLLOW_UP_STRATEGIES as readonly string[]).includes(format.followUpPolicy.strategy)) {
      issue(issues, `${path}.followUpPolicy.strategy`, 'invalid-value', '未知追问策略');
    }
    if (!rubricIds.has(format.rubricId)) {
      issue(issues, `${path}.rubricId`, 'missing-reference', `Rubric 不存在：${format.rubricId}`);
    }
    if (format.capabilityId !== undefined && !isStablePluginId(format.capabilityId)) {
      issue(issues, `${path}.capabilityId`, 'invalid-id', 'Capability ID 不合法');
    }
  });

  pack.rubrics.forEach((rubric, rubricIndex) => {
    const path = `rubrics[${rubricIndex}]`;
    validateUniqueIds(rubric.dimensions, `${path}.dimensions`, issues);
    if (rubric.dimensions.length === 0) {
      issue(issues, `${path}.dimensions`, 'invalid-value', 'Rubric 至少需要一个评分维度');
    }
    validateWeightTotal(rubric.dimensions, `${path}.dimensions`, issues);
    rubric.dimensions.forEach((dimension, dimensionIndex) => {
      validateAnchors(dimension.anchors, `${path}.dimensions[${dimensionIndex}].anchors`, issues);
    });
    if (
      rubric.passThreshold !== undefined &&
      (!Number.isFinite(rubric.passThreshold) ||
        rubric.passThreshold < 1 ||
        rubric.passThreshold > 5)
    ) {
      issue(issues, `${path}.passThreshold`, 'invalid-value', '通过阈值必须在 1–5 内');
    }
  });

  pack.taskTemplates.forEach((task, index) => {
    const path = `taskTemplates[${index}]`;
    if (!isNonEmpty(task.taskKind)) {
      issue(issues, `${path}.taskKind`, 'invalid-value', '任务类型不能为空');
    }
    if (!Number.isFinite(task.defaultMinutes) || task.defaultMinutes <= 0) {
      issue(issues, `${path}.defaultMinutes`, 'invalid-value', '默认时长必须大于 0');
    }
    (task.supportedFormats ?? []).forEach((formatId, formatIndex) => {
      if (!formatIds.has(formatId)) {
        issue(
          issues,
          `${path}.supportedFormats[${formatIndex}]`,
          'missing-reference',
          `面试形式不存在：${formatId}`,
        );
      }
    });
    if (task.capabilityId !== undefined && !isStablePluginId(task.capabilityId)) {
      issue(issues, `${path}.capabilityId`, 'invalid-id', 'Capability ID 不合法');
    }
  });

  const preferred = new Set<string>();
  pack.sourcePolicy.preferredDomains.forEach((domain, index) => {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) {
      issue(issues, `sourcePolicy.preferredDomains[${index}]`, 'invalid-value', '域名不能为空');
    }
    if (preferred.has(normalized)) {
      issue(
        issues,
        `sourcePolicy.preferredDomains[${index}]`,
        'duplicate-id',
        `重复域名：${domain}`,
      );
    }
    preferred.add(normalized);
  });
  Object.entries(pack.sourcePolicy.credibilityOverrides ?? {}).forEach(([domain, credibility]) => {
    if (!domain.trim() || !Number.isFinite(credibility) || credibility < 0 || credibility > 5) {
      issue(
        issues,
        `sourcePolicy.credibilityOverrides.${domain}`,
        'invalid-value',
        '可信度必须是 0–5',
      );
    }
  });

  validatePromptFragments(pack.promptFragments, formatIds, issues);
  return issues;
}

export function validateCapabilityPlugin(plugin: CapabilityPlugin): PluginContractIssue[] {
  const issues = validatePluginManifest(plugin.manifest);
  if (plugin.manifest.type !== 'capability') {
    issue(issues, 'manifest.type', 'invalid-value', 'CapabilityPlugin 的类型必须是 capability');
  }
  if (typeof plugin.register !== 'function') {
    issue(issues, 'register', 'invalid-value', 'CapabilityPlugin 必须提供 register 函数');
  }
  return issues;
}

export function assertValidPluginManifest(manifest: PluginManifest): void {
  const issues = validatePluginManifest(manifest);
  if (issues.length > 0) throw new PluginContractError(issues);
}

export function assertValidRolePack(pack: RolePack): void {
  const issues = validateRolePack(pack);
  if (issues.length > 0) throw new PluginContractError(issues);
}

export function assertValidCapabilityPlugin(plugin: CapabilityPlugin): void {
  const issues = validateCapabilityPlugin(plugin);
  if (issues.length > 0) throw new PluginContractError(issues);
}
