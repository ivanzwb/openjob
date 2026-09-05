/**
 * 领域实体类型，与 src/main/db/schema.ts 的表结构一一对应。
 * 主进程与渲染进程共用，避免两侧手工同步类型。
 *
 * 约定：
 * - 时间统一为 epoch 毫秒（number），跨 IPC 序列化无损，避免 Date 在结构化克隆中的歧义
 * - 日期（无时间部分）用 'YYYY-MM-DD' 字符串
 * - 可空字段显式写 `| null`，与 SQLite 的 NULL 对齐，不用 `?`
 */

import type {
  AnnotationKind,
  AnnotationTarget,
  CampaignStatus,
  CoverageType,
  EdgeRelation,
  EvidenceKind,
  ExamForm,
  ExplanationTier,
  MasterySource,
  MessageRole,
  NodeKind,
  NodeStatus,
  PlanDayStatus,
  ReportSourceType,
  RepoStatus,
  SessionKind,
  SourceProvider,
  SpeechSourceType,
  TaskKind,
  TaskStatus,
  ToolName,
} from './enums';

export type Id = string;
/** epoch 毫秒 */
export type Timestamp = number;
/** 'YYYY-MM-DD' */
export type DateOnly = string;

// ---------------------------------------------------------------------------
// Campaign 与输入
// ---------------------------------------------------------------------------

/** 简历独立存储，可跨 Campaign 复用 */
export interface Resume {
  id: Id;
  label: string;
  rawText: string;
  parsed: ResumeParsed | null;
  /** 排版模板等预览样式，JSON 字符串；null 表示用默认模板 */
  previewStyle: string | null;
  /** 寸照，data URL；null 表示没放照片 */
  photo: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface JobTarget {
  id: Id;
  company: string;
  roleTitle: string;
  jdRaw: string;
  jdParsed: JdParsed | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ResumeVariant {
  id: Id;
  /** 生成时的母版；母版被删后置空，优化版自己独立存在 */
  sourceResumeId: Id | null;
  jobTargetId: Id;
  label: string;
  contentMd: string;
  changelogMd: string;
  previewStyle: string | null;
  /** 寸照，data URL；生成时继承母版 */
  photo: string | null;
  isUserEdited: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ResumeParsed {
  /** 简历中出现的技术栈，是判定 deepDive / landmine 的依据 */
  skills: string[];
  projects: Array<{
    name: string;
    summary: string;
    /** 该项目中可被深挖的技术点 */
    drillableTopics: string[];
  }>;
  yearsOfExperience: number | null;
}

export interface JdParsed {
  roleTitle: string;
  /** 技能要求及其在 JD 中的权重 0-1 */
  requirements: Array<{ skill: string; weight: number }>;
  seniority: string | null;
}

/** Campaign 的岗位选择意图；精确插件版本只保存在 binding 中。 */
export interface RoleProfile {
  id: Id;
  roleFamily: string;
  rolePackId: string;
  level: string | null;
  industryPackId: string | null;
  location: string | null;
  interviewLanguage: string;
  confidence: number;
  userConfirmed: boolean;
}

export interface CampaignPluginBinding {
  id: Id;
  campaignId: Id;
  pluginId: string;
  pluginVersion: string;
  configJson: unknown;
  configSnapshotHash: string;
  revision: number;
  activeExecution: boolean;
  enabledAt: Timestamp;
}

/** 系统的中心对象：一场具体面试的备考单元 */
export interface Campaign {
  id: Id;
  company: string;
  roleTitle: string;
  jdRaw: string;
  jdParsed: JdParsed | null;
  jobTargetId: Id | null;
  roleProfileId: Id | null;
  resumeId: Id | null;
  /** 面试日期，驱动整个日程编排 */
  interviewDate: DateOnly | null;
  dailyMinutes: number | null;
  status: CampaignStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// 知识点
// ---------------------------------------------------------------------------

export interface KnowledgeNode {
  id: Id;
  campaignId: Id;
  parentId: Id | null;
  name: string;
  kind: NodeKind;
  coverageType: CoverageType;
  /** 考察概率 0-1，由 JD 权重 × 简历匹配 × 模型先验 × 真题回流修正得出 */
  examProb: number;
  difficulty: number;
  estMinutes: number;
  examForms: ExamForm[];
  /** 0-5，优先级排序的关键输入 */
  mastery: number;
  masterySource: MasterySource;
  priorityScore: number;
  status: NodeStatus;
  /** 用于细化时的去重合并与真题匹配；不下发给渲染进程 */
  embedding?: number[] | null;
  isUserAdded: boolean;
  /** 考我缓存的题目 */
  quizQuestionMd: string | null;
  /** 考我缓存的推荐答案 */
  quizRecommendedAnswerMd: string | null;
  createdAt: Timestamp;
}

export interface NodeEdge {
  id: Id;
  fromNodeId: Id;
  toNodeId: Id;
  relation: EdgeRelation;
}

export interface Explanation {
  id: Id;
  nodeId: Id;
  tier: ExplanationTier;
  contentMd: string;
  modelUsed: string;
  sourceIds: Id[];
  createdAt: Timestamp;
}

/** 优先级得分的构成，必须对用户可见——Agent 一旦成为黑盒就没人跟着走 */
export interface PriorityBreakdown {
  nodeId: Id;
  examProb: number;
  masteryGap: number;
  estMinutes: number;
  score: number;
  /** 人类可读的排序依据说明 */
  reason: string;
}

// ---------------------------------------------------------------------------
// 外部来源与检索
// ---------------------------------------------------------------------------

export interface Source {
  id: Id;
  url: string;
  domain: string;
  title: string;
  provider: SourceProvider;
  /** 域名可信度 0-5，0 为黑名单直接过滤 */
  credibility: number;
  publishedAt: Timestamp | null;
  fetchedAt: Timestamp;
  contentMd: string | null;
}

/** 附着在任意结论上的出处，UI 用 SourceBadge 渲染 */
export interface Citation {
  kind: EvidenceKind;
  /** kind === 'web' 时指向 Source */
  sourceId?: Id;
  url?: string;
  title?: string;
  /** kind === 'code' 时的代码位置 */
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface CompanyIntel {
  id: Id;
  campaignId: Id;
  techStackMd: string;
  /** 面试流程直接影响日程编排（几轮、各轮形式） */
  interviewProcessMd: string;
  hotTopicsMd: string;
  /** 反问环节可用的素材 */
  talkingPointsMd: string;
  sourceIds: Id[];
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// 面经摄入（三入口统一管道）
// ---------------------------------------------------------------------------

export interface InterviewReport {
  id: Id;
  campaignId: Id | null;
  company: string;
  roleTitle: string;
  sourceType: ReportSourceType;
  sourceId: Id | null;
  rawText: string;
  reportedAt: Timestamp | null;
  /** 按来源类型决定，selfDebrief 最高 */
  credibilityWeight: number;
  createdAt: Timestamp;
}

export interface InterviewQuestion {
  id: Id;
  reportId: Id;
  questionText: string;
  roundNo: number | null;
  matchedNodeId: Id | null;
  matchConfidence: number | null;
  /** 匹配不到任何节点 = 图谱预测失败，信息价值最高 */
  isBlindSpot: boolean;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// 计划与执行
// ---------------------------------------------------------------------------

export interface PlanDay {
  id: Id;
  campaignId: Id;
  date: DateOnly;
  plannedMinutes: number;
  status: PlanDayStatus;
}

export interface Task {
  id: Id;
  planDayId: Id;
  nodeId: Id | null;
  repoId: Id | null;
  kind: TaskKind;
  estMinutes: number;
  actualMinutes: number | null;
  status: TaskStatus;
  orderIdx: number;
}

/** 掌握度的唯一客观来源 */
export interface QuizAttempt {
  id: Id;
  nodeId: Id;
  question: string;
  userAnswer: string;
  /** 1-5 */
  score: number;
  feedbackMd: string;
  /** 把用户的回答改写成更好的口语表述 */
  improvedScriptMd: string | null;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// 源码
// ---------------------------------------------------------------------------

export interface Repo {
  id: Id;
  url: string;
  localPath: string;
  defaultBranch: string | null;
  commitSha: string | null;
  languages: string[];
  /** tree-sitter 生成的符号骨架，作为 Agent 的导航地图 */
  repoMapMd: string | null;
  summaryMd: string | null;
  indexedAt: Timestamp | null;
  status: RepoStatus;
}

export interface CodeRef {
  id: Id;
  repoId: Id;
  filePath: string;
  startLine: number;
  endLine: number;
  commitSha: string | null;
  snippet: string | null;
}

// ---------------------------------------------------------------------------
// 标记与话术
// ---------------------------------------------------------------------------

/** 统一标记表：知识点、讲解片段、代码位置、真题、情报卡共用 */
export interface Annotation {
  id: Id;
  targetType: AnnotationTarget;
  targetId: Id;
  kind: AnnotationKind;
  selectedText: string | null;
  noteMd: string | null;
  highlightColor: string | null;
  selectionStart: number | null;
  createdAt: Timestamp;
}

/** 所有链路的终点产出：面试时能说出口的话 */
export interface SpeechSnippet {
  id: Id;
  sourceType: SpeechSourceType;
  sourceId: Id;
  tier: ExplanationTier;
  contentMd: string;
  /** 用户改写成自己的话之后置为 true，背书面语一听就假 */
  isUserEdited: boolean;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// 会话与可观测性
// ---------------------------------------------------------------------------

export interface Session {
  id: Id;
  campaignId: Id | null;
  kind: SessionKind;
  title: string;
  createdAt: Timestamp;
}

export interface Message {
  id: Id;
  sessionId: Id;
  role: MessageRole;
  contentMd: string;
  citations: Citation[];
  createdAt: Timestamp;
}

/** 推理过程 trace，目的是建立信任而非 debug；同时作为 Agent 的决策输入 */
export interface ToolCallRecord {
  id: Id;
  messageId: Id;
  toolName: ToolName;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
  tokenCost: number | null;
  createdAt: Timestamp;
}
