/**
 * 全局枚举与联合类型。
 * 使用 `as const` 对象 + 派生联合类型，而非 TS enum：
 * 值在运行时可枚举（用于校验、下拉选项），类型在编译期收窄。
 */

export const LLM_TIERS = ['main', 'cheap'] as const;
export type LlmTier = (typeof LLM_TIERS)[number];

/** 业务角色只做 → 档位映射，不直接持有模型配置 */
export const LLM_ROLES = ['outline', 'explain', 'codeAgent', 'quiz'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export const CAMPAIGN_STATUSES = ['planning', 'active', 'done'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * 知识点的覆盖类型，由 JD × 简历交叉分析得出，决定准备策略与优先级。
 * - deepDive: 简历写了 + JD 要求 → 必被深挖，要扛得住追问
 * - gap:      JD 要求 + 简历没有 → 短板，答出框架不露怯
 * - landmine: 简历写了 + JD 没要求 → 雷区，容易被顺嘴一问问崩
 * - extra:    都没有但相关 → 有余力再看
 */
export const COVERAGE_TYPES = ['deepDive', 'gap', 'landmine', 'extra'] as const;
export type CoverageType = (typeof COVERAGE_TYPES)[number];

export const NODE_KINDS = ['domain', 'topic', 'point'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATUSES = ['todo', 'learning', 'shaky', 'mastered'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** 只保留三种语义明确的横向关系，不做任意网状连接 */
export const EDGE_RELATIONS = ['prerequisite', 'related', 'contrast'] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/**
 * 讲解的三档深度。`spoken` 是主战场，必须是口语稿而非书面语。
 */
export const EXPLANATION_TIERS = ['oneliner', 'spoken', 'deep'] as const;
export type ExplanationTier = (typeof EXPLANATION_TIERS)[number];

export const EXAM_FORMS = ['concept', 'coding', 'design', 'scenario'] as const;
export type ExamForm = (typeof EXAM_FORMS)[number];

export const MASTERY_SOURCES = ['self', 'quiz', 'mixed'] as const;
export type MasterySource = (typeof MASTERY_SOURCES)[number];

export const SEARCH_PROVIDERS = ['bocha', 'tavily'] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/** 外部内容的获取方式，`manual` 表示用户手动粘贴 */
export const SOURCE_PROVIDERS = ['bocha', 'tavily', 'manual'] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

/**
 * 面经来源。三个入口走同一条摄入管道，仅可信度权重不同。
 * selfDebrief（自己面完复盘）权重最高，web（搜索抓取）最低。
 */
export const REPORT_SOURCE_TYPES = ['web', 'pasted', 'selfDebrief'] as const;
export type ReportSourceType = (typeof REPORT_SOURCE_TYPES)[number];

export const PLAN_DAY_STATUSES = ['pending', 'done', 'skipped', 'deferred'] as const;
export type PlanDayStatus = (typeof PLAN_DAY_STATUSES)[number];

/** fallbackScript = 时间不够的知识点，生成 30 秒兜底话术 */
export const TASK_KINDS = ['learn', 'drill', 'readCode', 'review', 'fallbackScript'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ['pending', 'done', 'skipped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 标记的目标类型，统一 annotation 表靠它区分 */
export const ANNOTATION_TARGETS = [
  'node',
  'explanation',
  'codeRef',
  'question',
  'intel',
] as const;
export type AnnotationTarget = (typeof ANNOTATION_TARGETS)[number];

export const ANNOTATION_KINDS = ['highlight', 'note', 'elaboration', 'bookmark'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const SPEECH_SOURCE_TYPES = ['node', 'codeRef', 'quiz', 'design'] as const;
export type SpeechSourceType = (typeof SPEECH_SOURCE_TYPES)[number];

export const SESSION_KINDS = ['quiz', 'repoQa', 'freeChat', 'nodeFollowUp', 'planning'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const REPO_STATUSES = ['pending', 'cloning', 'indexing', 'ready', 'failed'] as const;
export type RepoStatus = (typeof REPO_STATUSES)[number];

/**
 * 信息来源可信度分级，UI 上用角标区分，可信度递增。
 * 技术内容尤其需要让用户知道哪些结论值得再验证一遍。
 */
export const EVIDENCE_KINDS = ['model', 'web', 'code'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Agent 共享工具箱 */
export const TOOL_NAMES = [
  'web_search',
  'fetch_url',
  'list_dir',
  'read_file',
  'grep',
  'query_graph',
  'update_mastery',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
