import type {
  CompetencyCategory,
  FollowUpStrategy,
  InterviewProtocol,
  PluginType,
  RuntimeAvailability,
} from '../enums';
import type { InteractionResultSchema, InteractionSchema } from './interactions/schema';
import type { PluginPermission } from './permissions';
export type { PluginPermission };

export type ClientPlatform = 'desktop' | 'mobile';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PluginCompatibility {
  /** Core Agent 的 SemVer 范围，例如 ^1.0.0。 */
  core: string;
  /** 插件能够读取的最小持久化 schema 版本。 */
  schema: number;
}

export interface PluginDependency {
  id: string;
  /** 依赖插件的 SemVer 范围。 */
  version: string;
  optional?: boolean;
}

export interface PluginRuntimeAvailability {
  desktop: RuntimeAvailability;
  mobile: RuntimeAvailability;
}

export interface PluginManifest {
  id: string;
  version: string;
  type: PluginType;
  displayName: string;
  description: string;
  compatibility: PluginCompatibility;
  permissions: PluginPermission[];
  /** 代码入口（相对包根）。v1 固定为 'main.js'；缺省 = 纯声明式插件，不进入激活生命周期 */
  main?: string;
  /** 所需 openjob.* API 版本范围（如 '^1.0'）；与 main 必须成对声明 */
  api?: string;
  runtime?: PluginRuntimeAvailability;
  /** artifact type → schema version。 */
  artifactSchemas?: Record<string, number>;
  /**
   * interaction type → schema version。
   *
   * 与 artifactSchemas 同构：本机只读 Manifest 就能判断认不认识某个交互版本，
   * 不必执行插件的 register()。
   */
  interactionSchemas?: Record<string, number>;
  dependencies?: PluginDependency[];
}

export interface RoleMatcher {
  /** 与标准化岗位标题匹配的大小写不敏感正则字符串。 */
  titlePatterns: string[];
  /** JD 中出现任一信号时提高匹配置信度。 */
  responsibilitySignals?: string[];
  /** 出现任一信号时降低匹配置信度。 */
  excludeSignals?: string[];
}

export interface CompetencyLevelIndicator {
  level: number;
  behavior: string;
}

export interface CompetencyTemplate {
  /** 岗位包内稳定 ID，例如 pm.problem-framing。 */
  id: string;
  name: string;
  category: CompetencyCategory;
  description: string;
  /** 0–1，岗位包内所有能力权重之和必须为 1。 */
  defaultWeight: number;
  levelIndicators: CompetencyLevelIndicator[];
  evidenceKinds: string[];
  /** 引用本岗位包的 InterviewFormatDefinition.id。 */
  supportedFormats: string[];
}

export interface InterviewStageTemplate {
  id: string;
  label: string;
  order: number;
  /** 该阶段可使用的题型 ID。 */
  formatIds: string[];
  /** 0–1，表示该阶段在默认面试蓝图中的权重。 */
  defaultWeight: number;
}

export interface FollowUpPolicy {
  maxRounds: number;
  strategy: FollowUpStrategy;
}

export interface InterviewFormatDefinition {
  id: string;
  label: string;
  protocol: InterviewProtocol;
  defaultDurationMinutes: number;
  followUpPolicy: FollowUpPolicy;
  rubricId: string;
  capabilityId?: string;
}

export type RubricScore = 1 | 2 | 3 | 4 | 5;
export type RubricAnchors = Record<RubricScore, string>;

export interface RubricDimension {
  id: string;
  label: string;
  /** 0–1；同一 Rubric 中所有维度权重之和必须为 1。 */
  weight: number;
  anchors: RubricAnchors;
  critical?: boolean;
}

export interface RubricDefinition {
  id: string;
  dimensions: RubricDimension[];
  /** 归一化后的 1–5 总分阈值。 */
  passThreshold?: number;
  failConditions?: string[];
}

export interface TaskTemplate {
  id: string;
  label: string;
  /** 允许岗位包定义新任务 ID；旧 TaskKind 由工程岗位包适配。 */
  taskKind: string;
  defaultMinutes: number;
  supportedFormats?: string[];
  capabilityId?: string;
}

export type ResumeModuleKind = 'list' | 'structured' | 'text';

/**
 * 宿主页面注册表：导航入口只能引用这里已实现的页面。
 * 页面组件由各端宿主实现（desktop/renderer 有自己的 component 映射），
 * core 只拥有 id 清单——契约校验据此拒绝引用不存在页面的入口。
 */
export const HOST_PAGE_IDS = ['source-repository'] as const;

export type HostPageId = (typeof HOST_PAGE_IDS)[number];

export const RESUME_MODULE_KINDS = [
  'list',
  'structured',
  'text',
] as const satisfies readonly ResumeModuleKind[];

/**
 * 插入点 A：导航入口。
 *
 * 入口渲染在主导航的固定能力页签槽位；runtime 决定功能层级而非入口生死——
 * 入口消失只有两种合法情况：包不声明，或所有 Campaign 都未启用对应能力。
 */
export interface NavigationEntry {
  /** 岗位包内稳定 ID，例如 se.source-repository。 */
  id: string;
  label: string;
  /** 只能引用宿主页面注册表中已实现的页面，插件不能注入组件。 */
  pageId: HostPageId;
  /** 入口可见性跟随该能力的启用状态；缺省表示不依赖能力。 */
  requiredCapabilityId?: string;
  /** 功能降级（view-only / 需桌面完成）时的一句说明；缺省用宿主默认文案。 */
  degradedHint?: string;
}

/**
 * 插入点 D：岗位包声明的简历模块。
 *
 * 声明让简历解析与展示跟随岗位：解析时按 instruction 追加抽取指令，
 * 展示时按激活包的模块列表渲染宿主实现的模块卡。旧字段（skills 等）
 * 通过 deriveFrom 映射为默认模块，老简历不需要重新解析。
 */
export interface ResumeModuleDefinition {
  /** 岗位包内稳定 ID，例如 se.tech-stack、pm.business-metrics。 */
  id: string;
  label: string;
  kind: ResumeModuleKind;
  /** 抽取指令（内联正文）。与 extractionPromptFile 互斥。 */
  instruction?: string;
  /** 包内 markdown 文件路径（相对包根）。与 instruction 互斥。 */
  extractionPromptFile?: string;
  /** 加载器从 extractionPromptFile 读入的指令正文。 */
  text?: string;
  /** 模块数据 schema 版本；展示端按版本决定渲染方式，未知版本只保留不展示。 */
  schemaVersion: number;
  evidenceKinds: string[];
  /**
   * 未抽到数据时从 ResumeParsed 通用字段派生：
   * - 'skills'：技术栈列表；
   * - 'drillableTopics'：各项目可深挖点的扁平列表。
   * 声明了 deriveFrom 的模块不参与模型抽取（工程包因此零行为变化）。
   */
  deriveFrom?: 'skills' | 'drillableTopics';
}

/**
 * 插入点 B 的 Slot 清单：岗位包能贡献片段的阶段。
 * 粒度是「阶段」而不是某次模型调用——一个阶段内的多次宿主子调用共享同一片段。
 */
export const PROMPT_SLOTS = [
  'diagnosis',
  'explanation',
  'questionGeneration',
  'scoring',
  'answerCoaching',
  'debrief',
] as const;

export type PromptSlot = (typeof PROMPT_SLOTS)[number];

/**
 * 插入点 B 的一条片段。
 *
 * 正文归岗位包所有：新岗位包用 `file` 指向包内 markdown 片段文件
 * （frontmatter 声明 slot / formatId，正文由加载器填进 `text`）；
 * `ref` 是迁移期通道，显式引用宿主 Prompt Registry 的 promptId，
 * 仅供 software-engineering 等历史包使用，与 `file` 互斥。
 */
export interface PromptFragment {
  slot: PromptSlot;
  /** 限定题型；缺省 = 该 slot 的全题型兜底。 */
  formatId?: string;
  /** 包内片段文件路径（相对包根）。与 ref 互斥。 */
  file?: string;
  /** 片段正文：authoring 时由加载器从 file 读入；分发信封内联。 */
  text?: string;
  /** 宿主 promptId（迁移期）。与 file 互斥。 */
  ref?: string;
}

export interface SourcePolicy {
  preferredDomains: string[];
  blockedDomains?: string[];
  /** 域名 → 可信度 0–5。 */
  credibilityOverrides?: Record<string, number>;
  freshnessDays?: {
    companyIntel?: number;
    interviewReports?: number;
    domainKnowledge?: number;
  };
}

export interface RolePack {
  manifest: PluginManifest;
  roleMatchers: RoleMatcher[];
  competencyTemplates: CompetencyTemplate[];
  interviewStages: InterviewStageTemplate[];
  interviewFormats: InterviewFormatDefinition[];
  rubrics: RubricDefinition[];
  taskTemplates: TaskTemplate[];
  promptFragments: PromptFragment[];
  // 插入点 A：导航入口
  navigation: NavigationEntry[];
  // 插入点 D：简历模块
  resumeModules: ResumeModuleDefinition[];
  // 插入点 E：内嵌能力声明
  capabilities: CapabilityDeclaration[];
  /**
   * 代码插件资产（§7.9）：manifest.main 声明时由 defineRolePack 从包目录内联
   * （main.js 与 ui/**），随 pack.json 走信封与移动端同步——与 promptFragments
   * 内联正文同一个模型。纯声明式岗位包为空。
   */
  codeAssets?: Record<string, string>;
  sourcePolicy: SourcePolicy;
}

export interface ResolvedPluginRef {
  id: string;
  /** Resolver 激活后固定为精确 SemVer，不再是范围。 */
  version: string;
}

export type ResolvedCapabilityRef =
  | (ResolvedPluginRef & {
      enabled: true;
      disabledReason?: never;
    })
  | {
      id: string;
      /** 未安装的可选依赖没有可固定的精确版本。 */
      version?: string;
      enabled: false;
      disabledReason: string;
    };

export interface CampaignRuntimeDescriptor {
  campaignId: string;
  coreVersion: string;
  rolePack: ResolvedPluginRef;
  industryPack?: ResolvedPluginRef;
  capabilities: ResolvedCapabilityRef[];
  competencyBaselineVersion: string;
  configSnapshotHash: string;
  resolvedAt: number;
}

/**
 * 宿主渲染的交互声明。
 *
 * inputSchema / resultSchema 用 Core 拥有的封闭字段协议（见 ./interactions/schema），
 * 不是任意 JSON Schema：任意 schema 无法保证宿主渲染得出来，会逼出「插件自带组件」
 * 的逃逸口。插件只声明结构，宿主负责渲染，两者之间不传组件。
 */
export interface HostRenderedInteraction {
  type: string;
  schemaVersion: number;
  availability: Record<ClientPlatform, RuntimeAvailability>;
  inputSchema: InteractionSchema;
  resultSchema: InteractionResultSchema;
}

export interface ScopedToolDefinition {
  name: string;
  description: string;
  permission: PluginPermission;
  inputSchemaVersion: number;
}

export interface ArtifactParserDefinition {
  artifactType: string;
  schemaVersion: number;
  permission: PluginPermission;
}

export interface CapabilityRegistry {
  registerTool(tool: ScopedToolDefinition): void;
  registerArtifactParser(parser: ArtifactParserDefinition): void;
  registerInteractionType(type: HostRenderedInteraction): void;
}

/**
 * 插入点 E：岗位包内嵌的能力声明。
 *
 * **声明归插件包所有**：工具定义、交互 schema、解析器类型是随包分发的数据
 * （与 prompts 片段同一个模型），core 不持有任何具体能力的清单——它只负责
 * 校验声明的结构与一致性，不认识「source-repository」这类具体 id。
 *
 * `implementations` 是宿主侧的实现绑定提示：声明了 tool 的能力需要宿主
 * （desktop main）有同名工具实现，否则能力不可激活。执行代码永远在宿主。
 */
export interface CapabilityDeclaration {
  /** 能力 id，包内唯一；例如 source-repository。 */
  id: string;
  /** 工具贡献契约；声明的工具由宿主按 toolName 绑定实现。 */
  tools?: ScopedToolDefinition[];
  /** 宿主渲染的交互声明；schema 校验与桌面端一致。 */
  interactions?: HostRenderedInteraction[];
  /** artifact 解析器类型声明；文件读取与解析由宿主按授权执行。 */
  artifactParsers?: ArtifactParserDefinition[];
  /**
   * 无逐项 permission 字段的贡献（如交互）所需的额外权限。
   * manifest.permissions 必须等于 tools/parsers 的 permission 加上这里的并集。
   */
  permissions?: PluginPermission[];
}

export interface CapabilityPlugin {
  manifest: PluginManifest;
  register(registry: CapabilityRegistry): void;
}
