import type {
  CompetencyCategory,
  FollowUpStrategy,
  InterviewProtocol,
  PluginType,
  RuntimeAvailability,
} from '../enums';
import type { PluginPermission } from './permissions';

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
  runtime?: PluginRuntimeAvailability;
  /** artifact type → schema version。 */
  artifactSchemas?: Record<string, number>;
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

export interface PromptFragmentSet {
  diagnosis?: string;
  explanation?: string;
  questionGeneration?: Record<string, string>;
  scoring?: Record<string, string>;
  answerCoaching?: Record<string, string>;
  debrief?: string;
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
  promptFragments: PromptFragmentSet;
  sourcePolicy: SourcePolicy;
}

export interface ResolvedPluginRef {
  id: string;
  /** Resolver 激活后固定为精确 SemVer，不再是范围。 */
  version: string;
}

export interface ResolvedCapabilityRef extends ResolvedPluginRef {
  enabled: boolean;
  disabledReason?: string;
}

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
 * T19 会为 JSON Schema 增加可执行的宿主渲染器；T01 只冻结跨端声明。
 */
export interface HostRenderedInteraction {
  type: string;
  schemaVersion: number;
  availability: Record<ClientPlatform, RuntimeAvailability>;
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

export interface CapabilityPlugin {
  manifest: PluginManifest;
  register(registry: CapabilityRegistry): void;
}
