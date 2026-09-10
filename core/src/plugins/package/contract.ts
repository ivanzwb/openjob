/**
 * 外置插件包的磁盘格式。
 *
 * 包一律是纯数据。这不是保守起见，而是现有契约本来就够用：CapabilityRegistry 的三个
 * 注册方法（registerTool / registerArtifactParser / registerInteractionType）接受的全是
 * 可序列化结构，工具的真实实现留在宿主里（见 builtin/sourceRepository/index.ts 的
 * 「declaration only」注释，实现在 src/main/repo/tools.ts）。既然插件从来只贡献声明，
 * 就没有理由把外部代码加载进主进程——隔离保障因此完整保留，而不是退到运行时拦截。
 *
 * 代价要说清楚：外置包只能声明宿主已经实现的东西。它扩展的是配置面（岗位、题型、
 * 量规、提示词、各类声明），不是宿主行为；真要加新行为，仍然得发基础包。
 */
import {
  PluginContractError,
  type PluginContractIssue,
  validatePluginManifest,
  validateRolePack,
} from '../contracts';
import { RUNTIME_AVAILABILITIES } from '../../enums';
import { isPluginPermission } from '../permissions';
import {
  validateInteractionResultSchema,
  validateInteractionSchema,
} from '../interactions/schema';
import type {
  ArtifactParserDefinition,
  HostRenderedInteraction,
  PluginManifest,
  RolePack,
  ScopedToolDefinition,
} from '../types';

export const PACKAGE_MANIFEST_FILE = 'manifest.json';
export const PACKAGE_PACK_FILE = 'pack.json';
export const PACKAGE_CONTRIBUTIONS_FILE = 'contributions.json';
export const PACKAGE_SIGNATURE_FILE = 'openjob.sig';

/**
 * 允许出现在包里的文件，除此之外一律拒装。
 *
 * 白名单而不是黑名单：黑名单挡不住没想到的扩展名，而「包里多一个文件」正是把可执行
 * 载荷夹带进来的唯一入口。
 */
export const PACKAGE_ALLOWED_FILES: readonly string[] = [
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  PACKAGE_CONTRIBUTIONS_FILE,
  PACKAGE_SIGNATURE_FILE,
];

/** 能力插件的注册声明，等价于 register() 会向 registry 推的那些东西。 */
export interface PluginPackageContributions {
  tools?: ScopedToolDefinition[];
  artifactParsers?: ArtifactParserDefinition[];
  interactions?: HostRenderedInteraction[];
}

/** 包内文件名 → utf8 文本。全部是 JSON/文本，没有二进制载荷。 */
export type PluginPackageFiles = Readonly<Record<string, string>>;

export interface ParsedPluginPackage {
  manifest: PluginManifest;
  /** type 为 role-pack 时给出，已拼好 manifest。 */
  rolePack?: RolePack;
  /** type 为 capability 时给出。 */
  contributions?: PluginPackageContributions;
}

function issue(
  issues: PluginContractIssue[],
  path: string,
  code: PluginContractIssue['code'],
  message: string,
): void {
  issues.push({ path, code, message });
}

function parseJson(
  files: PluginPackageFiles,
  name: string,
  issues: PluginContractIssue[],
): unknown {
  const raw = files[name];
  if (raw === undefined) {
    issue(issues, name, 'missing-reference', `包内缺少 ${name}`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    issue(issues, name, 'invalid-value', `${name} 不是合法 JSON：${(error as Error).message}`);
    return undefined;
  }
}

function validateTool(
  tool: ScopedToolDefinition,
  index: number,
  manifest: PluginManifest,
  issues: PluginContractIssue[],
): void {
  const path = `contributions.tools[${index}]`;
  if (typeof tool?.name !== 'string' || tool.name.length === 0) {
    issue(issues, `${path}.name`, 'invalid-value', '工具名不能为空');
  }
  if (typeof tool?.description !== 'string' || tool.description.length === 0) {
    issue(issues, `${path}.description`, 'invalid-value', '工具描述不能为空');
  }
  if (!Number.isInteger(tool?.inputSchemaVersion) || tool.inputSchemaVersion < 1) {
    issue(issues, `${path}.inputSchemaVersion`, 'invalid-value', 'inputSchemaVersion 必须是正整数');
  }
  if (!isPluginPermission(tool?.permission)) {
    issue(issues, `${path}.permission`, 'invalid-permission', `未知权限：${String(tool?.permission)}`);
  } else if (!manifest.permissions.includes(tool.permission)) {
    // 与 resolver 的 RegistrationCollector.assertPermission 同一条规则：注册项用到的权限
    // 必须先写进 manifest，否则装上之后才在解析期炸，用户看到的是一句无从下手的报错
    issue(
      issues,
      `${path}.permission`,
      'invalid-permission',
      `manifest 未声明该权限：${tool.permission}`,
    );
  }
}

function validateParser(
  parser: ArtifactParserDefinition,
  index: number,
  manifest: PluginManifest,
  issues: PluginContractIssue[],
): void {
  const path = `contributions.artifactParsers[${index}]`;
  if (typeof parser?.artifactType !== 'string' || parser.artifactType.length === 0) {
    issue(issues, `${path}.artifactType`, 'invalid-value', 'artifactType 不能为空');
    return;
  }
  if (!Number.isInteger(parser.schemaVersion) || parser.schemaVersion < 1) {
    issue(issues, `${path}.schemaVersion`, 'invalid-value', 'schemaVersion 必须是正整数');
  }
  if (!isPluginPermission(parser.permission)) {
    issue(issues, `${path}.permission`, 'invalid-permission', `未知权限：${String(parser.permission)}`);
  } else if (!manifest.permissions.includes(parser.permission)) {
    issue(
      issues,
      `${path}.permission`,
      'invalid-permission',
      `manifest 未声明该权限：${parser.permission}`,
    );
  }
  if (manifest.artifactSchemas?.[parser.artifactType] !== parser.schemaVersion) {
    issue(
      issues,
      `${path}.schemaVersion`,
      'missing-reference',
      `manifest.artifactSchemas 未声明同版本：${parser.artifactType}`,
    );
  }
}

function validateInteraction(
  interaction: HostRenderedInteraction,
  index: number,
  manifest: PluginManifest,
  issues: PluginContractIssue[],
): void {
  const path = `contributions.interactions[${index}]`;
  if (typeof interaction?.type !== 'string' || interaction.type.length === 0) {
    issue(issues, `${path}.type`, 'invalid-value', '交互类型不能为空');
    return;
  }
  if (!Number.isInteger(interaction.schemaVersion) || interaction.schemaVersion < 1) {
    issue(issues, `${path}.schemaVersion`, 'invalid-value', 'schemaVersion 必须是正整数');
  }
  if (manifest.interactionSchemas?.[interaction.type] !== interaction.schemaVersion) {
    issue(
      issues,
      `${path}.schemaVersion`,
      'missing-reference',
      `manifest.interactionSchemas 未声明同版本：${interaction.type}`,
    );
  }
  const availability = interaction.availability;
  if (
    !availability ||
    !(['desktop', 'mobile'] as const).every((platform) =>
      (RUNTIME_AVAILABILITIES as readonly string[]).includes(availability[platform]),
    )
  ) {
    issue(issues, `${path}.availability`, 'invalid-value', '两端运行能力都必须合法');
  }
  for (const schemaIssue of [
    ...validateInteractionSchema(interaction.inputSchema),
    ...validateInteractionResultSchema(interaction.resultSchema, interaction.inputSchema),
  ]) {
    issue(issues, `${path}.${schemaIssue.path}`, 'invalid-value', schemaIssue.message);
  }
}

function validateContributions(
  value: unknown,
  manifest: PluginManifest,
  issues: PluginContractIssue[],
): PluginPackageContributions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issue(issues, PACKAGE_CONTRIBUTIONS_FILE, 'invalid-value', 'contributions 必须是对象');
    return undefined;
  }
  const contributions = value as PluginPackageContributions;
  const lists: Array<[string, unknown]> = [
    ['tools', contributions.tools],
    ['artifactParsers', contributions.artifactParsers],
    ['interactions', contributions.interactions],
  ];
  for (const [key, list] of lists) {
    if (list !== undefined && !Array.isArray(list)) {
      issue(issues, `contributions.${key}`, 'invalid-value', `${key} 必须是数组`);
      return undefined;
    }
  }
  if (
    (contributions.tools?.length ?? 0) +
      (contributions.artifactParsers?.length ?? 0) +
      (contributions.interactions?.length ?? 0) ===
    0
  ) {
    issue(
      issues,
      PACKAGE_CONTRIBUTIONS_FILE,
      'invalid-value',
      '能力插件至少要声明一项注册内容，否则装上等于没装',
    );
  }

  contributions.tools?.forEach((tool, index) => validateTool(tool, index, manifest, issues));
  contributions.artifactParsers?.forEach((parser, index) =>
    validateParser(parser, index, manifest, issues),
  );
  contributions.interactions?.forEach((interaction, index) =>
    validateInteraction(interaction, index, manifest, issues),
  );
  return contributions;
}

/** RolePack 里必须存在的字段，与 types.ts 的 RolePack 一一对应。 */
const ROLE_PACK_ARRAY_FIELDS = [
  'roleMatchers',
  'competencyTemplates',
  'interviewStages',
  'interviewFormats',
  'rubrics',
  'taskTemplates',
] as const;

const ROLE_PACK_OBJECT_FIELDS = ['promptFragments', 'sourcePolicy'] as const;

function validateRolePackShape(pack: Record<string, unknown>): PluginContractIssue[] {
  const issues: PluginContractIssue[] = [];
  for (const field of ROLE_PACK_ARRAY_FIELDS) {
    if (!Array.isArray(pack[field])) {
      issue(issues, `pack.${field}`, 'invalid-value', `${field} 必须是数组`);
    }
  }
  for (const field of ROLE_PACK_OBJECT_FIELDS) {
    const value = pack[field];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issue(issues, `pack.${field}`, 'invalid-value', `${field} 必须是对象`);
    }
  }
  return issues;
}

/**
 * 校验一个解开的插件包。
 *
 * 只做结构与声明层面的校验，不碰签名（签名要 node:crypto，只能在主进程做，
 * 见 src/main/plugins/package/signature.ts）。
 *
 * **对任何输入都返回问题列表，绝不抛异常**：输入是不受信任的外部 JSON，调用方在安装与
 * 扫描路径上，一次意外抛出的后果是崩溃或半截安装，而不是一条「这个包不合法」。
 */
export function validatePluginPackage(files: PluginPackageFiles): PluginContractIssue[] {
  try {
    return validatePackageInternal(files);
  } catch (error) {
    // 兜底：上面的粗粒度检查覆盖了已知的坏形状，这里接住剩下的未知形状
    return [
      {
        path: PACKAGE_MANIFEST_FILE,
        code: 'invalid-value',
        message: `校验过程异常，包不可用：${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

function validatePackageInternal(files: PluginPackageFiles): PluginContractIssue[] {
  const issues: PluginContractIssue[] = [];

  const unexpected = Object.keys(files)
    .filter((name) => !PACKAGE_ALLOWED_FILES.includes(name))
    .sort();
  for (const name of unexpected) {
    issue(issues, name, 'invalid-value', `包内出现未知文件：${name}`);
  }

  const manifestValue = parseJson(files, PACKAGE_MANIFEST_FILE, issues);
  if (manifestValue === undefined) return issues;
  if (typeof manifestValue !== 'object' || manifestValue === null || Array.isArray(manifestValue)) {
    issue(issues, PACKAGE_MANIFEST_FILE, 'invalid-value', 'manifest 必须是对象');
    return issues;
  }

  const manifest = manifestValue as PluginManifest;
  issues.push(...validatePluginManifest(manifest));
  if (issues.some((item) => item.path.startsWith('manifest.'))) return issues;

  switch (manifest.type) {
    case 'role-pack': {
      if (files[PACKAGE_CONTRIBUTIONS_FILE] !== undefined) {
        issue(
          issues,
          PACKAGE_CONTRIBUTIONS_FILE,
          'invalid-value',
          '岗位包不注册能力，不该带 contributions.json',
        );
      }
      const packValue = parseJson(files, PACKAGE_PACK_FILE, issues);
      if (packValue === undefined) break;
      if (typeof packValue !== 'object' || packValue === null || Array.isArray(packValue)) {
        issue(issues, PACKAGE_PACK_FILE, 'invalid-value', 'pack 必须是对象');
        break;
      }
      // 先粗粒度查字段在不在、类型对不对，再交给 validateRolePack。后者是为仓库内的
      // 岗位包写的，靠 TypeScript 保证字段存在；喂给它一份缺字段的外部 JSON 会抛
      // TypeError 而不是返回问题列表，安装路径就变成了「崩」而不是「拒装」。
      const shapeIssues = validateRolePackShape(packValue as Record<string, unknown>);
      if (shapeIssues.length > 0) {
        issues.push(...shapeIssues);
        break;
      }
      issues.push(
        ...validateRolePack({ ...(packValue as Omit<RolePack, 'manifest'>), manifest }),
      );
      break;
    }
    case 'industry-pack': {
      // Industry Pack 目前只有 manifest（见 BuiltInPluginRegistry.registerIndustryPack）
      for (const name of [PACKAGE_PACK_FILE, PACKAGE_CONTRIBUTIONS_FILE]) {
        if (files[name] !== undefined) {
          issue(issues, name, 'invalid-value', `行业包只需要 manifest，不该带 ${name}`);
        }
      }
      break;
    }
    case 'capability': {
      if (files[PACKAGE_PACK_FILE] !== undefined) {
        issue(issues, PACKAGE_PACK_FILE, 'invalid-value', '能力插件不带岗位数据');
      }
      validateContributions(
        parseJson(files, PACKAGE_CONTRIBUTIONS_FILE, issues),
        manifest,
        issues,
      );
      break;
    }
    default:
      issue(issues, 'manifest.type', 'invalid-value', `未知插件类型：${String(manifest.type)}`);
  }

  return issues;
}

/** 校验并解析，失败抛 PluginContractError。 */
export function parsePluginPackage(files: PluginPackageFiles): ParsedPluginPackage {
  const issues = validatePluginPackage(files);
  if (issues.length > 0) throw new PluginContractError(issues);

  const manifest = JSON.parse(files[PACKAGE_MANIFEST_FILE]!) as PluginManifest;
  if (manifest.type === 'role-pack') {
    const pack = JSON.parse(files[PACKAGE_PACK_FILE]!) as Omit<RolePack, 'manifest'>;
    return { manifest, rolePack: { ...pack, manifest } };
  }
  if (manifest.type === 'capability') {
    return {
      manifest,
      contributions: JSON.parse(files[PACKAGE_CONTRIBUTIONS_FILE]!) as PluginPackageContributions,
    };
  }
  return { manifest };
}
