import {
  ANNOTATION_TARGETS,
  COMPETENCY_CATEGORIES,
  FOLLOW_UP_STRATEGIES,
  INTERVIEW_PROTOCOLS,
  PLUGIN_TYPES,
  RUNTIME_AVAILABILITIES,
} from '../enums';
import { isValidLlmRoleName } from '../llm/roles';
import { isPluginPermission } from './permissions';
import type {
  CapabilityDeclaration,
  CapabilityPlugin,
  NavigationEntry,
  PluginManifest,
  PromptFragment,
  ResumeModuleDefinition,
  RolePack,
  RubricAnchors,
} from './types';
import { PROMPT_SLOTS, RESUME_MODULE_KINDS } from './types';

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
/** 数据集合名：小写短横线命名，首个字符必须是字母。 */
const DATA_COLLECTION_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DATA_COLLECTION_NAME_MAX = 64;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SEMVER_RANGE_CHARS_RE = /^[0-9A-Za-z.*+<>=~^|\s-]+$/;

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
  // role-pack 的权限规则在 validateRolePack 里按内嵌能力并集校验
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

  // 代码插件入口（v3）：main / mobile 各指一端的实现，与 api 成对声明
  if (manifest.main !== undefined && manifest.main !== 'desktop/main.js') {
    issue(issues, 'manifest.main', 'invalid-value', '桌面入口固定为 desktop/main.js');
  }
  if (manifest.mobile !== undefined && manifest.mobile !== 'mobile/main.js') {
    issue(issues, 'manifest.mobile', 'invalid-value', '移动入口固定为 mobile/main.js');
  }
  if (manifest.main !== undefined || manifest.mobile !== undefined) {
    if (manifest.api === undefined || !isSemVerRange(manifest.api)) {
      issue(issues, 'manifest.api', 'invalid-version', '声明了代码入口就必须声明合法的 api 版本范围');
    }
  } else if (manifest.api !== undefined) {
    issue(issues, 'manifest.api', 'invalid-value', 'api 只能与代码入口成对声明');
  }

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

  Object.entries(manifest.interactionSchemas ?? {}).forEach(([interactionType, version]) => {
    if (!isStablePluginId(interactionType)) {
      issue(
        issues,
        `manifest.interactionSchemas.${interactionType}`,
        'invalid-id',
        'interaction type 不合法',
      );
    }
    if (!Number.isInteger(version) || version < 1) {
      issue(
        issues,
        `manifest.interactionSchemas.${interactionType}`,
        'invalid-value',
        'interaction schema 版本必须是正整数',
      );
    }
  });

  // 数据集合声明：名字只用于归档与取用，宿主不理解内容，所以这里只校验形状——
  // 非空、包内不重名、名字是小写短横线且不超过上限、schemaVersion 是正整数。
  const declaredCollections = manifest.dataCollections;
  if (declaredCollections !== undefined) {
    if (!Array.isArray(declaredCollections) || declaredCollections.length === 0) {
      issue(issues, 'manifest.dataCollections', 'invalid-value', 'dataCollections 必须是非空数组');
    } else {
      const seenCollections = new Set<string>();
      declaredCollections.forEach((collection, index) => {
        const path = `manifest.dataCollections[${index}]`;
        const name: unknown = collection?.name;
        if (
          typeof name !== 'string' ||
          name.length > DATA_COLLECTION_NAME_MAX ||
          !DATA_COLLECTION_NAME_RE.test(name)
        ) {
          issue(
            issues,
            `${path}.name`,
            'invalid-id',
            `集合名必须是小写短横线命名且不超过 ${DATA_COLLECTION_NAME_MAX} 字符`,
          );
        }
        if (typeof name === 'string') {
          if (seenCollections.has(name)) {
            issue(issues, `${path}.name`, 'duplicate-id', `重复集合名：${name}`);
          }
          seenCollections.add(name);
        }
        const schemaVersion: unknown = collection?.schemaVersion;
        if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
          issue(issues, `${path}.schemaVersion`, 'invalid-value', 'schemaVersion 必须是正整数');
        }
      });
    }
  }

  // 标记目标路由（插入点 F）：包声明哪种 targetKind 由本包哪个页面承接。形状校验同 dataCollections
  // 的思路——宿主不认识具体取值，只校验「不空、包内不重名、不占用宿主已知取值、pageId 非空」。
  const declaredAnnotationTargets = manifest.annotationTargets;
  if (declaredAnnotationTargets !== undefined) {
    if (!Array.isArray(declaredAnnotationTargets) || declaredAnnotationTargets.length === 0) {
      issue(
        issues,
        'manifest.annotationTargets',
        'invalid-value',
        'annotationTargets 必须是非空数组',
      );
    } else {
      const hostTargets = new Set<string>(ANNOTATION_TARGETS);
      const seenKinds = new Set<string>();
      declaredAnnotationTargets.forEach((target, index) => {
        const path = `manifest.annotationTargets[${index}]`;
        const kind: unknown = target?.kind;
        if (!isNonEmpty(kind)) {
          issue(issues, `${path}.kind`, 'invalid-value', '目标类型不能为空');
        } else {
          if (hostTargets.has(kind)) {
            issue(
              issues,
              `${path}.kind`,
              'invalid-value',
              `目标类型不得占用宿主已知取值：${kind}`,
            );
          }
          if (seenKinds.has(kind)) {
            issue(issues, `${path}.kind`, 'duplicate-id', `重复目标类型：${kind}`);
          }
          seenKinds.add(kind);
        }
        if (!isNonEmpty(target?.label)) {
          issue(issues, `${path}.label`, 'invalid-value', '展示名不能为空');
        }
        if (!isNonEmpty(target?.pageId)) {
          issue(issues, `${path}.pageId`, 'invalid-value', 'pageId 不能为空');
        }
      });
    }
  }

  return issues;
}

function validatePromptFragments(
  fragments: PromptFragment[],
  formatIds: Set<string>,
  issues: PluginContractIssue[],
): void {
  if (!Array.isArray(fragments)) {
    issue(issues, 'promptFragments', 'invalid-value', 'promptFragments 必须是数组');
    return;
  }
  const seen = new Set<string>();
  fragments.forEach((fragment, index) => {
    const path = `promptFragments[${index}]`;
    if (!(PROMPT_SLOTS as readonly string[]).includes(fragment.slot)) {
      issue(issues, `${path}.slot`, 'invalid-prompt-slot', '不允许的 Prompt Slot');
    }
    if (fragment.formatId !== undefined && !formatIds.has(fragment.formatId)) {
      issue(issues, `${path}.formatId`, 'missing-reference', '引用了未定义的面试形式');
    }
    const hasFile = typeof fragment.file === 'string';
    const hasRef = typeof fragment.ref === 'string';
    if (hasFile === hasRef) {
      issue(
        issues,
        path,
        'invalid-value',
        '片段必须且只能选择 file（包内 markdown 文件）或 ref（迁移期 promptId）之一',
      );
    }
    if (hasFile) {
      if (!isNonEmpty(fragment.text)) {
        issue(issues, `${path}.text`, 'invalid-value', 'file 片段正文为空：文件未被加载或内容为空');
      }
      if (!fragment.file!.startsWith('prompts/')) {
        issue(issues, `${path}.file`, 'invalid-value', '片段文件必须位于包内 prompts/ 目录');
      }
    }
    if (hasRef && !isNonEmpty(fragment.ref)) {
      issue(issues, `${path}.ref`, 'invalid-value', 'promptId 引用不能为空');
    }
    const key = `${fragment.slot}::${fragment.formatId ?? '*'}`;
    if (seen.has(key)) {
      issue(issues, path, 'duplicate-id', `同 slot 同题型只能声明一个片段：${key}`);
    }
    seen.add(key);
  });
}

function validateResumeModules(
  modules: ResumeModuleDefinition[],
  issues: PluginContractIssue[],
): void {
  if (!Array.isArray(modules)) {
    issue(issues, 'resumeModules', 'invalid-value', 'resumeModules 必须是数组');
    return;
  }
  validateUniqueIds(modules, 'resumeModules', issues);
  modules.forEach((module, index) => {
    const path = `resumeModules[${index}]`;
    if (!(RESUME_MODULE_KINDS as readonly string[]).includes(module.kind)) {
      issue(issues, `${path}.kind`, 'invalid-value', '未知的简历模块类型');
    }
    if (!isNonEmpty(module.label)) {
      issue(issues, `${path}.label`, 'invalid-value', '模块展示名不能为空');
    }
    if (!Number.isInteger(module.schemaVersion) || module.schemaVersion < 1) {
      issue(issues, `${path}.schemaVersion`, 'invalid-value', 'schemaVersion 必须是正整数');
    }
    if ((module.evidenceKinds ?? []).length === 0) {
      issue(issues, `${path}.evidenceKinds`, 'invalid-value', '至少声明一种证据类型');
    }
    // 可派生模块从旧字段回填，不参与模型抽取，也不该带指令
    const needsInstruction = module.deriveFrom === undefined;
    const hasInline = typeof module.instruction === 'string';
    const hasFile = typeof module.extractionPromptFile === 'string';
    if (needsInstruction && hasInline === hasFile) {
      issue(
        issues,
        path,
        'invalid-value',
        '模块必须且只能选择 instruction（内联指令）或 extractionPromptFile（包内文件）之一',
      );
    }
    if (!needsInstruction && (hasInline || hasFile)) {
      issue(
        issues,
        path,
        'invalid-value',
        '声明了 deriveFrom 的模块从旧字段回填，不要再带抽取指令',
      );
    }
    if (hasInline && !isNonEmpty(module.instruction)) {
      issue(issues, `${path}.instruction`, 'invalid-value', '抽取指令不能为空');
    }
    if (hasFile && !isNonEmpty(module.extractionPromptFile)) {
      issue(issues, `${path}.extractionPromptFile`, 'invalid-value', '指令文件路径不能为空');
    }
    if (
      module.deriveFrom !== undefined &&
      !['skills', 'drillableTopics'].includes(module.deriveFrom)
    ) {
      issue(issues, `${path}.deriveFrom`, 'invalid-value', '未知的旧字段派生来源');
    }
  });
}

function validateNavigation(entries: NavigationEntry[], issues: PluginContractIssue[]): void {
  if (!Array.isArray(entries)) {
    issue(issues, 'navigation', 'invalid-value', 'navigation 必须是数组');
    return;
  }
  validateUniqueIds(entries, 'navigation', issues);
  entries.forEach((entry, index) => {
    const path = `navigation[${index}]`;
    if (!isNonEmpty(entry.label)) {
      issue(issues, `${path}.label`, 'invalid-value', '入口展示名不能为空');
    }
    if (
      entry.requiredCapabilityId !== undefined &&
      !isStablePluginId(entry.requiredCapabilityId)
    ) {
      issue(issues, `${path}.requiredCapabilityId`, 'invalid-id', 'Capability ID 不合法');
    }
  });
}

/**
 * 内嵌声明的 schema 版本必须与 manifest 对得上。
 *
 * 与能力包同一条规则（见 package/contract.ts 对 contributions 的校验）：声明归包所有，
 * 而 manifest 是宿主的唯一事实源——解析期会按 manifest 声明的版本决定「认不认得这份数据」。
 * 包自己不写清楚的话，那一步只能等到运行时才发现对不上。
 */
function validateDeclarationSchemas(
  pack: RolePack,
  declaration: CapabilityDeclaration,
  issues: PluginContractIssue[],
): void {
  for (const parser of declaration.artifactParsers ?? []) {
    if (pack.manifest.artifactSchemas?.[parser.artifactType] === parser.schemaVersion) continue;
    issue(
      issues,
      `manifest.artifactSchemas.${parser.artifactType}`,
      'missing-reference',
      `能力 ${declaration.id} 声明了解析器 ${parser.artifactType}@${parser.schemaVersion}，` +
        'manifest 必须声明同一版本',
    );
  }
  for (const interaction of declaration.interactions ?? []) {
    if (pack.manifest.interactionSchemas?.[interaction.type] === interaction.schemaVersion) continue;
    issue(
      issues,
      `manifest.interactionSchemas.${interaction.type}`,
      'missing-reference',
      `能力 ${declaration.id} 声明了交互 ${interaction.type}@${interaction.schemaVersion}，` +
        'manifest 必须声明同一版本',
    );
  }
}

/**
 * 能力声明的 LLM 角色。
 *
 * 角色名会进 config.json 当 key、会进审计记录，所以形状必须可控；同一个包里重复声明
 * 同一个角色说明作者对「谁拥有这个角色」没想清楚，也在这里拦下。
 */
function validateLlmRoles(
  declaration: CapabilityDeclaration,
  declaredRoles: Set<string>,
  issues: PluginContractIssue[],
): void {
  const roles = declaration.llmRoles;
  if (roles === undefined) return;
  const path = `capabilities[${declaration.id}].llmRoles`;
  if (!Array.isArray(roles)) {
    issue(issues, path, 'invalid-value', 'llmRoles 必须是数组');
    return;
  }
  for (const role of roles) {
    if (!isValidLlmRoleName(role?.name)) {
      issue(issues, path, 'invalid-value', `角色名不合法：${String(role?.name)}`);
      continue;
    }
    if (role.hint !== undefined && (typeof role.hint !== 'string' || role.hint.trim() === '')) {
      issue(issues, `${path}[${role.name}].hint`, 'invalid-value', 'hint 必须是非空字符串');
    }
    if (declaredRoles.has(role.name)) {
      issue(issues, path, 'duplicate-id', `重复声明的角色：${role.name}`);
      continue;
    }
    declaredRoles.add(role.name);
  }
}

function validateCapabilities(
  pack: RolePack,
  issues: PluginContractIssue[],
): void {
  if (!Array.isArray(pack.capabilities)) {
    issue(issues, 'capabilities', 'invalid-value', 'capabilities 必须是数组');
    return;
  }
  validateUniqueIds(pack.capabilities, 'capabilities', issues);

  // 声明归包所有：core 不认识具体能力 id，只校验声明结构的一致性——
  // 权限并集规则（声明少于实现会漏授权，多于实现是凭空要权）依然成立，
  // 但事实源是声明本身，不是某个宿主内置清单。
  const declared = new Set<string>();
  const declaredRoles = new Set<string>();
  for (const declaration of pack.capabilities) {
    // 注册内容、权限、LLM 角色都算声明的内容：页面自己编排通用原语的能力只有权限与角色，
    // 没有可注册的东西，也是一条有内容的能力；三者全空的声明才等于装上没装。
    const declaresSomething =
      (declaration.tools?.length ?? 0) +
        (declaration.interactions?.length ?? 0) +
        (declaration.artifactParsers?.length ?? 0) +
        (declaration.permissions?.length ?? 0) +
        (declaration.llmRoles?.length ?? 0) >
      0;
    if (!declaresSomething) {
      issue(
        issues,
        `capabilities[${declaration.id}]`,
        'invalid-value',
        '能力声明至少要声明一项内容（工具 / 交互 / 解析器 / 权限 / LLM 角色），否则装上等于没装',
      );
    }
    for (const tool of declaration.tools ?? []) {
      declared.add(tool.permission);
    }
    for (const parser of declaration.artifactParsers ?? []) {
      declared.add(parser.permission);
    }
    for (const permission of declaration.permissions ?? []) {
      declared.add(permission);
    }
    // 交互的 schema 深校验交给 resolver 的 RegistrationCollector，这里不重复
    validateLlmRoles(declaration, declaredRoles, issues);
    validateDeclarationSchemas(pack, declaration, issues);
  }

  const expected = [...declared].sort();
  const actual = [...pack.manifest.permissions].sort();
  if (actual.join(',') !== expected.join(',')) {
    issue(
      issues,
      'manifest.permissions',
      'invalid-permission',
      `权限必须等于内嵌能力贡献的权限并集 [${expected.join(', ')}]，当前为 [${actual.join(', ')}]`,
    );
  }
}

/**
 * 行业差异变体：包内声明、按 id 引用（见 RolePack.industryVariants）。
 *
 * 只校验形状——id 稳定且包内唯一、展示名与描述非空。宿主不认识任何具体变体 id，
 * 「这个行业差异怎么影响出题与评分」归包自己负责。
 */
function validateIndustryVariants(pack: RolePack, issues: PluginContractIssue[]): void {
  const variants = pack.industryVariants;
  if (variants === undefined) return;
  if (!Array.isArray(variants) || variants.length === 0) {
    issue(issues, 'industryVariants', 'invalid-value', 'industryVariants 必须是非空数组');
    return;
  }
  validateUniqueIds(variants, 'industryVariants', issues);
  variants.forEach((variant, index) => {
    const path = `industryVariants[${index}]`;
    if (!isNonEmpty(variant?.displayName)) {
      issue(issues, `${path}.displayName`, 'invalid-value', '行业变体展示名不能为空');
    }
    if (!isNonEmpty(variant?.description)) {
      issue(issues, `${path}.description`, 'invalid-value', '行业变体描述不能为空');
    }
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

  const declaredCollectionNames = new Set(
    (pack.manifest.dataCollections ?? []).map((collection) => collection.name),
  );

  pack.taskTemplates.forEach((task, index) => {
    const path = `taskTemplates[${index}]`;
    if (!isNonEmpty(task.taskKind)) {
      issue(issues, `${path}.taskKind`, 'invalid-value', '任务类型不能为空');
    }
    if (!Number.isFinite(task.defaultMinutes) || task.defaultMinutes <= 0) {
      issue(issues, `${path}.defaultMinutes`, 'invalid-value', '默认时长必须大于 0');
    }
    // materialKind 与 materialCollection 必须成对：只要材料类型却不说材料放在哪个集合，
    // 排程就无表可读；反过来只声明集合却不声明类型，宿主也不知道该拿它做什么。
    const hasMaterialKind = task.materialKind !== undefined;
    const hasMaterialCollection = task.materialCollection !== undefined;
    if (hasMaterialKind !== hasMaterialCollection) {
      issue(
        issues,
        `${path}.${hasMaterialKind ? 'materialCollection' : 'materialKind'}`,
        'missing-reference',
        'materialKind 与 materialCollection 必须成对声明',
      );
    }
    if (hasMaterialCollection && !declaredCollectionNames.has(task.materialCollection!)) {
      issue(
        issues,
        `${path}.materialCollection`,
        'missing-reference',
        `材料集合必须在本包 manifest.dataCollections 中声明：${task.materialCollection}`,
      );
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
  validateResumeModules(pack.resumeModules, issues);
  validateNavigation(pack.navigation, issues);
  validateCapabilities(pack, issues);
  validateIndustryVariants(pack, issues);
  const codeAssets = pack.codeAssets ?? {};
  if (pack.manifest.main !== undefined && !isNonEmpty(codeAssets['desktop/main.js'])) {
    issue(
      issues,
      'codeAssets',
      'invalid-value',
      '声明了 main 却缺少 desktop/main.js 代码资产（defineRolePack 会从包目录内联）',
    );
  }
  if (pack.manifest.mobile !== undefined && !isNonEmpty(codeAssets['mobile/main.js'])) {
    issue(
      issues,
      'codeAssets',
      'invalid-value',
      '声明了 mobile 却缺少 mobile/main.js 代码资产（defineRolePack 会从包目录内联）',
    );
  }
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
