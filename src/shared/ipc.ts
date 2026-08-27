/**
 * IPC 契约：主进程与渲染进程之间的唯一通信面，替代 HTTP 路由。
 *
 * 两类通道：
 * - invoke: 请求/响应，对应 ipcMain.handle
 * - event:  主进程单向推送，用于流式输出与长任务进度
 *
 * 渲染进程只能通过 preload 暴露的白名单方法访问这里声明的通道。
 */

import type { AppConfig, UiTheme } from './config';
import type {
  EvidenceKind,
  LlmRole,
  LlmTier,
  NodeKind,
  SearchProviderName,
  CampaignStatus,
  CoverageType,
  NodeStatus,
  ExplanationTier,
  ReportSourceType,
  AnnotationTarget,
  AnnotationKind,
  SessionKind,
  EdgeRelation,
  TaskKind,
} from './enums';
import type {
  Campaign,
  Citation,
  CompanyIntel,
  Explanation,
  InterviewReport,
  JobTarget,
  KnowledgeNode,
  PlanDay,
  QuizAttempt,
  Repo,
  Resume,
  SpeechSnippet,
  Task,
  Annotation,
  JdParsed,
} from './entities';
import type {
  BackupInfo,
  FieldOverwrite,
  PairingPayload,
  SyncRunSummary,
  SyncStatus,
} from './sync';
import type { MockInterviewKind, MockInterviewLanguage } from './design/prompts';

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 自动更新状态机。disabled 表示没配更新源或处在开发模式 */
export interface UpdateStatus {
  state: 'idle' | 'disabled' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

export interface AppPaths {
  userData: string;
  dbFile: string;
  reposDir: string;
  cacheDir: string;
  backupsDir: string;
}

/** 长任务（clone、索引）的进度上报 */
export interface JobProgress {
  jobId: string;
  label: string;
  /** 0-1，未知总量时为 null */
  progress: number | null;
  message: string;
  done: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** 由角色决定用哪个 provider 和 model，调用方不直接指定模型 */
  role: LlmRole;
  messages: ChatMessage[];
  /** 开启后 Agent 可自行决定是否联网检索 */
  allowWebSearch?: boolean;
  /** 关闭时不注入任何工具（图谱/联网/读代码等），仅多轮对话 */
  allowTools?: boolean;
  /** 指定后启用代码 Agent 工具集（list_dir / read_file / grep） */
  repoId?: string;
  sessionId?: string;
  campaignId?: string;
  /** nodeFollowUp 会话所属知识点，用于跨端恢复同一段历史 */
  nodeId?: string;
  /** 新建会话时落库的分类；已有 sessionId 时忽略 */
  sessionKind?: SessionKind;
}

export interface StreamStarted {
  streamId: string;
  sessionId: string | null;
}

export interface StreamDelta {
  streamId: string;
  /** 增量文本 */
  delta: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StreamToolCall {
  streamId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
}

export interface StreamDone {
  streamId: string;
  sessionId: string | null;
  contentMd: string;
  citations: Citation[];
  /** 本次回答的主要信息来源类型，UI 用 SourceBadge 渲染 */
  evidenceKind: EvidenceKind;
  usage: TokenUsage | null;
}

export interface StreamError {
  streamId: string;
  message: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number | null;
  model: string;
  message: string;
  /** codeAgent 角色的硬性要求 */
  supportsToolCalling: boolean | null;
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  /** 不传则按 routing 规则自动选择 provider */
  provider?: SearchProviderName;
  /** 时效过滤，面经检索应传 'oneYear' */
  freshness?: 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';
  count?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** 低于此可信度的结果直接丢弃，默认 1（仅过滤黑名单） */
  minCredibility?: number;
  /** 决定缓存时长，不同类型内容的新鲜度要求差别很大 */
  cacheCategory?: 'companyIntel' | 'interviewReports' | 'techDocs';
  /** 跳过缓存强制重新检索 */
  noCache?: boolean;
  /** 覆盖 Tavily 的地域偏好（小写英文国名，如 china）；不传用配置里的值 */
  country?: string;
}

export interface SearchResultItem {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  contentMd: string | null;
  publishedAt: number | null;
  credibility: number;
  /** 落库后的 source 行 id，供面经等下游关联出处；命中缓存时也带着 */
  sourceId?: string;
  /** 距发布多少天，publishedAt 缺失时为 null */
  ageDays?: number | null;
  /** 技术文档超过时效阈值，引用前需核对版本 */
  stale?: boolean;
}

export interface SearchResponse {
  provider: SearchProviderName;
  query: string;
  results: SearchResultItem[];
  /** 命中缓存时为 true，用于在 UI 上标注数据新鲜度 */
  fromCache: boolean;
  fetchedAt: number;
}

export interface FetchUrlRequest {
  url: string;
}

export interface FetchUrlResponse {
  url: string;
  title: string;
  contentMd: string;
  fetchedAt: number;
  /** 落库后的 source 行 id */
  sourceId?: string;
}

// ---------------------------------------------------------------------------
// Campaign / 诊断（阶段 1）
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  id: string;
  company: string;
  roleTitle: string;
  status: CampaignStatus;
  interviewDate: string | null;
  nodeCount: number;
  hasResume: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignOverview {
  campaignCount: number;
  activeCampaignCount: number;
  totalSpeechSnippets: number;
  totalBlindSpots: number;
  avgMastery: number;
  campaigns: CampaignSummary[];
  weakNodes: Array<{
    campaignId: string;
    company: string;
    roleTitle: string;
    nodeId: string;
    nodeName: string;
    mastery: number;
  }>;
  priorByCompany: Array<{
    company: string;
    campaignCount: number;
    reportCount: number;
  }>;
}

/** 带优先级依据的节点，供考点清单展示 */
export interface KnowledgeNodeView extends KnowledgeNode {
  priorityReason: string;
  hasExplanation?: boolean;
}

export interface CampaignDetail {
  campaign: Campaign;
  resume: Resume | null;
  nodes: KnowledgeNodeView[];
  intel: CompanyIntel | null;
  reportCount: number;
  blindSpotQuestions: BlindSpotQuestion[];
  historicalPriorCampaigns: number;
}

export interface BlindSpotQuestion {
  id: string;
  questionText: string;
  reportedAt: number | null;
}

/** 面经条目 + 出处。网络来源必须能回溯到链接与抓取时间 */
export interface InterviewReportView {
  id: string;
  sourceType: ReportSourceType;
  reportedAt: number | null;
  createdAt: number;
  credibilityWeight: number;
  excerpt: string;
  questionCount: number;
  blindSpotCount: number;
  source: {
    url: string;
    domain: string;
    title: string;
    credibility: number;
    fetchedAt: number;
    publishedAt: number | null;
  } | null;
}

export interface CreateCampaignInput {
  /** 优先：选择已有目标岗位 */
  jobTargetId?: string;
  company?: string;
  roleTitle?: string;
  jdRaw?: string;
}

export interface UpdateCampaignInput {
  id: string;
  company?: string;
  roleTitle?: string;
  jdRaw?: string;
  resumeId?: string | null;
  interviewDate?: string | null;
  dailyMinutes?: number | null;
  status?: CampaignStatus;
}

export interface CreateResumeInput {
  label: string;
  rawText: string;
}

export interface UpdateResumeInput {
  id: string;
  label?: string;
  rawText?: string;
  previewStyle?: string;
  /** 寸照 data URL；null 表示移除照片，不传表示不动 */
  photo?: string | null;
}

export interface CreateJobTargetInput {
  company: string;
  roleTitle: string;
  jdRaw: string;
}

export interface UpdateJobTargetInput {
  id: string;
  company?: string;
  roleTitle?: string;
  jdRaw?: string;
  jdParsed?: JdParsed | null;
}

export interface ResumeVariantView {
  id: string;
  /** 生成时的母版；母版被删后为 null，优化版仍然独立可用 */
  sourceResumeId: string | null;
  jobTargetId: string;
  label: string;
  contentMd: string;
  changelogMd: string;
  previewStyle: string | null;
  photo: string | null;
  isUserEdited: boolean;
  createdAt: number;
  updatedAt: number;
  company: string;
  roleTitle: string;
  sourceResumeLabel: string;
  sourceResumeText: string;
}

export interface UpdateResumeVariantInput {
  id: string;
  label?: string;
  contentMd?: string;
  changelogMd?: string;
  previewStyle?: string;
  /** 寸照 data URL；null 表示移除照片，不传表示不动 */
  photo?: string | null;
}

/**
 * 母版与优化版共用的 PDF 导出入参。
 * 正文与样式由渲染进程直接给出，导出结果与预览一致，不受未保存改动影响。
 */
export interface ResumeExportInput {
  /** 文件名，不含扩展名 */
  fileStem: string;
  contentMd: string;
  previewStyle: string;
  headline: string;
  subtitle?: string;
  /** 寸照 data URL，导出与预览用同一张 */
  photo?: string | null;
}

export interface ResumeExportResult {
  saved: boolean;
  path: string | null;
}

/** 交给模型重新归类到固定模块，只返回 markdown，不落库 */
export interface ResumeStructureInput {
  contentMd: string;
}

export interface ResumeStructureResult {
  contentMd: string;
  /** 模型用不上时退回了规则识别，带上原因供界面提示用户 */
  fallbackReason?: string;
}

/** 创建/导入简历的返回：模型归类失败退回规则时带原因，供界面提示用户 */
export type ResumeImportResult = Resume & { fallbackReason?: string };

/** 只优化当前编辑的那一块，整份简历作为上下文，不落库 */
export interface ResumePolishInput {
  /** 整份简历 markdown，供模型理解上下文 */
  resumeMd: string;
  /** 固定模块 key，如 summary / skills / experience */
  sectionKey: string;
  /** 定位到具体条目，如「腾讯科技 | 前端工程师」 */
  scopeLabel?: string;
  /** 当前文本框内容，可为空 */
  contentMd: string;
  /** 用户的额外要求，可为空 */
  instruction?: string;
}

export interface ResumePolishResult {
  contentMd: string;
}

export interface OptimizeResumeInput {
  sourceResumeId: string;
  jobTargetId: string;
}

export interface CreateNodeInput {
  campaignId: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
}

export interface UpdateNodeInput {
  id: string;
  name?: string;
  coverageType?: CoverageType;
  status?: NodeStatus;
}

export interface DiagnosisJobStarted {
  jobId: string;
}

export interface IngestReportInput {
  campaignId: string;
  rawText: string;
  sourceType?: ReportSourceType;
}

export interface IngestReportResult {
  report: InterviewReport;
  questionsExtracted: number;
  nodesUpdated: number;
  blindSpotsCreated: number;
  crossCampaignUpdated: number;
  /** 被 ≥2 个独立来源提到，视为已交叉验证 */
  corroboratedCount: number;
  /** 仅单一来源提到，权重打折并标存疑 */
  unverifiedCount: number;
}

export interface IngestWebResult {
  reports: IngestReportResult[];
  sourcesFetched: number;
  totalQuestions: number;
  totalNodesUpdated: number;
}

// ---------------------------------------------------------------------------
// 会话历史
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  campaignId: string | null;
  nodeId: string | null;
  kind: SessionKind;
  title: string;
  createdAt: number;
  messageCount: number;
  /** 会话累计 token，端点不返回 usage 的部分不计入 */
  totalTokens: number;
}

export interface SessionMessageView {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  contentMd: string;
  citations: Citation[];
  createdAt: number;
  usage: TokenUsage | null;
  /** 证据等级，用于历史回看时还原来源角标；老数据为 null */
  evidenceKind: EvidenceKind | null;
  /** 该条回答下挂的工具调用，含各自摊到的 token 成本 */
  toolCalls: ToolCallView[];
}

export interface ToolCallView {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
  tokenCost: number | null;
}

export interface SessionSearchHit extends SessionSummary {
  /** 命中的消息条数 */
  matchCount: number;
  /** 命中处的上下文片段 */
  snippet: string;
}

// ---------------------------------------------------------------------------
// 知识点关系与主动提示
// ---------------------------------------------------------------------------

export interface NodeEdgeView {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromName: string;
  toName: string;
  relation: EdgeRelation;
}

export interface CreateEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeRelation;
}

export type NudgeKind =
  | 'blindSpot'
  | 'repeatedMiss'
  | 'unpreparedLandmine'
  | 'stalledTask'
  | 'askedOften';

export interface Nudge {
  kind: NudgeKind;
  severity: 'high' | 'medium' | 'low';
  nodeId: string | null;
  title: string;
  detail: string;
}

export interface HistorySignalResult {
  /** 因反复提问/反复答错而提权的考点数 */
  boosted: number;
  /** 因长期拖延而拆小的考点数 */
  eased: number;
  nudges: Nudge[];
}

// ---------------------------------------------------------------------------
// 计划与执行（阶段 2）
// ---------------------------------------------------------------------------

export interface TodayCampaignOption {
  id: string;
  company: string;
  roleTitle: string;
  status: string;
  hasPlanToday: boolean;
  completedCount: number;
  totalCount: number;
}

export interface TaskView extends Task {
  nodeName: string | null;
  nodeCoverage: CoverageType | null;
  repoUrl: string | null;
}

export interface TodayPlan {
  campaignId: string;
  company: string;
  roleTitle: string;
  date: string;
  planDay: PlanDay | null;
  tasks: TaskView[];
  completedCount: number;
  totalCount: number;
  plannedMinutes: number;
}

export interface PlanGenerateInput {
  campaignId: string;
  /** 未设置时使用 campaign 上的值，再没有则用默认 14 天 / 90 分钟 */
  interviewDate?: string;
  dailyMinutes?: number;
}

export interface PlanGenerateResult {
  daysCreated: number;
  tasksCreated: number;
  overflowFallbacks: number;
}

export interface PlanDateOption {
  date: string;
  taskCount: number;
}

export interface TaskAddInput {
  campaignId: string;
  date: string;
  kind: TaskKind;
  nodeId?: string | null;
  repoId?: string | null;
  estMinutes?: number;
}

export interface ExplainGetInput {
  nodeId: string;
  tier: ExplanationTier;
}

export interface ExplainGenerateInput {
  nodeId: string;
  tier: ExplanationTier;
  /** 重新生成时用户临时提的要求，一次性的，不落库 */
  instruction?: string;
}

export interface ExplainUpdateInput {
  id: string;
  contentMd: string;
}

export interface ExplainElaborateInput {
  nodeId: string;
  tier: ExplanationTier;
  selectedText: string;
  /** 当前讲解全文，供模型把握上下文 */
  contextMd?: string;
}

export interface ExplainElaborateResult {
  selectedText: string;
  elaborationMd: string;
}

export interface ExplainRewriteInput {
  nodeId: string;
  tier: ExplanationTier;
  selectedText: string;
  contextMd?: string;
}

export interface ExplainRewriteResult {
  selectedText: string;
  rewrittenMd: string;
}

export interface QuizDraftResult {
  nodeId: string;
  nodeName: string;
  questionMd: string | null;
  recommendedAnswerMd: string | null;
}

export interface QuizUpdateDraftInput {
  nodeId: string;
  questionMd?: string | null;
  recommendedAnswerMd?: string | null;
}

export interface QuizQuestionResult {
  nodeId: string;
  nodeName: string;
  question: string;
}

export interface QuizAnswerInput {
  nodeId: string;
  question: string;
}

export interface QuizAnswerResult {
  recommendedAnswerMd: string;
}

export interface QuizSubmitInput {
  nodeId: string;
  question: string;
  userAnswer: string;
}

export interface QuizSubmitResult {
  attempt: QuizAttempt;
  masteryUpdated: number;
  nodeStatus: NodeStatus;
}

// ---------------------------------------------------------------------------
// 源码仓库（阶段 3）
// ---------------------------------------------------------------------------

/** 系统 git 探测结果。缺 git 时源码模块整体不可用，需提前告知而非 clone 到一半报错 */
export interface GitStatus {
  available: boolean;
  /** 如 "git version 2.45.0"，不可用时为 null */
  version: string | null;
  /** 不可用时给出的安装引导 */
  hint: string | null;
}

export interface RepoAddInput {
  url: string;
}

/**
 * 删除仓库的结果。
 *
 * 本地 clone 删不掉时条目照样移除——目录删不掉就不让删条目的话，同一个仓库
 * 每次点删除都撞同一个错，永远清不掉。残留目录连同原因交给用户手删。
 */
export interface RepoDeleteResult {
  /** 没能删掉的本地目录完整路径；全部删干净时为 null */
  leftoverPath: string | null;
  /** 删不掉的原因，界面原样展示 */
  reason: string | null;
}

export interface RepoReadFileInput {
  repoId: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface RepoReadFileResult {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
}

export interface SpeechSaveInput {
  repoId: string;
  contentMd: string;
  tier?: ExplanationTier;
}

export interface SpeechSaveFromNodeInput {
  nodeId: string;
  contentMd: string;
  tier?: ExplanationTier;
}

export interface SpeechSaveFromDesignInput {
  campaignId: string;
  contentMd: string;
}

export interface SpeechSaveFromQuizInput {
  nodeId: string;
  contentMd: string;
}

/** 某个来源（考点、仓库…）下已存过的话术，用来判断这段选区是不是已经进过库 */
export interface SpeechListForSourceInput {
  sourceType: SpeechSnippet['sourceType'];
  sourceId: string;
}

export interface SpeechSnippetView extends SpeechSnippet {
  sourceLabel: string;
}

export interface SpeechUpdateInput {
  id: string;
  contentMd: string;
}

export interface SpeechExportInput {
  format: 'markdown' | 'anki' | 'pdf';
  ids?: string[];
}

export interface SpeechExportResult {
  saved: boolean;
  path: string | null;
  count: number;
}

// ---------------------------------------------------------------------------
// 模拟面试（原系统设计，现覆盖多类题型）
// ---------------------------------------------------------------------------

export type MockInterviewType = MockInterviewKind | 'mixed';

export const MOCK_INTERVIEW_TYPE_OPTIONS: Array<{
  value: MockInterviewType;
  label: string;
  hint: string;
}> = [
  { value: 'selfIntro', label: '自我介绍', hint: '开场介绍、亮点匹配、表达自然度' },
  { value: 'concept', label: '概念 / 八股', hint: '原理、机制、对比追问' },
  { value: 'coding', label: '编码 / 算法', hint: '手写代码、复杂度分析' },
  { value: 'design', label: '系统设计', hint: '架构、扩展性、权衡' },
  { value: 'scenario', label: '项目 / 场景', hint: '简历深挖、行为场景' },
  { value: 'mixed', label: '综合模拟', hint: '根据公司/JD/简历自动选题' },
];

export const MOCK_INTERVIEW_TYPE_LABELS: Record<MockInterviewKind, string> = {
  concept: '概念 / 八股',
  coding: '编码 / 算法',
  design: '系统设计',
  scenario: '项目 / 场景',
  selfIntro: '自我介绍',
};

export const MOCK_INTERVIEW_LANGUAGE_OPTIONS: Array<{
  value: MockInterviewLanguage;
  label: string;
}> = [
  { value: 'zh', label: '中文面试' },
  { value: 'en', label: '英文面试' },
];

export const MOCK_INTERVIEW_LANGUAGE_LABELS: Record<MockInterviewLanguage, string> = {
  zh: '中文',
  en: '英文',
};

/**
 * 题目里那组约束的小标题。
 *
 * 放共享层是因为它已经跑偏过一次：桌面端叫「约束 / 考察点」，手机端叫「考察点」，
 * 同一道题在两块屏幕上像是两个不同的字段。各写一份的文案迟早会各自漂移。
 */
export const MOCK_INTERVIEW_CONSTRAINTS_LABEL = '约束 / 考察点';

export interface DesignCaseResult {
  campaignId: string;
  company: string;
  roleTitle: string;
  interviewType: MockInterviewKind;
  interviewLanguage: MockInterviewLanguage;
  relatedNodeName: string | null;
  title: string;
  scenarioMd: string;
  constraints: string[];
  evaluationCriteria: string[];
  userAnswerMd?: string | null;
  recommendedAnswerMd?: string | null;
}

export interface DesignSubmitInput {
  campaignId: string;
  caseTitle: string;
  scenarioMd: string;
  userAnswer: string;
  interviewType?: MockInterviewKind;
  interviewLanguage?: MockInterviewLanguage;
  requestedType?: MockInterviewType;
}

export interface DesignSubmitResult {
  score: number;
  feedbackMd: string;
  improvedOutlineMd: string;
  speechSnippetId: string;
}

export interface DesignUpdateAnswersInput {
  campaignId: string;
  interviewType: MockInterviewType;
  interviewLanguage: MockInterviewLanguage;
  userAnswerMd?: string | null;
  recommendedAnswerMd?: string | null;
}

export interface DesignGenerateAnswerInput {
  campaignId: string;
  caseTitle: string;
  scenarioMd: string;
  interviewType: MockInterviewKind;
  interviewLanguage: MockInterviewLanguage;
  constraints?: string[];
}

export interface DesignGenerateAnswerResult {
  recommendedAnswerMd: string;
}

export interface DesignElaborateInput {
  selectedText: string;
  contextMd: string;
  /**
   * 主进程据此回查简历，细化时才不会拿 JD 当候选人做过的项目。
   * 可选是因为手机端远程调用这条链路时不一定带得上，缺了就退化成不带简历上下文。
   */
  campaignId?: string;
}

export interface DesignElaborateResult {
  elaborationMd: string;
}

// ---------------------------------------------------------------------------
// 标注
// ---------------------------------------------------------------------------

export interface AnnotationCreateInput {
  targetType: AnnotationTarget;
  targetId: string;
  kind: AnnotationKind;
  selectedText?: string;
  noteMd?: string;
  highlightColor?: string;
  selectionStart?: number;
}

export interface AnnotationToggleInput {
  targetType: AnnotationTarget;
  targetId: string;
}

/** 标记 + 目标的可读名字，供「我的标记」这类跨类型汇总列表使用 */
export interface AnnotationView extends Annotation {
  targetLabel: string;
}

export interface EnsureCodeRefInput {
  repoId: string;
  filePath: string;
  startLine: number;
  endLine?: number;
}

// ---------------------------------------------------------------------------
// Campaign 对比
// ---------------------------------------------------------------------------

export interface CampaignCompareResult {
  campaignA: { id: string; company: string; roleTitle: string };
  campaignB: { id: string; company: string; roleTitle: string };
  overlaps: Array<{
    nodeName: string;
    masteryA: number;
    masteryB: number;
    examProbA: number;
    examProbB: number;
  }>;
  onlyA: Array<{ nodeName: string; mastery: number; examProb: number }>;
  onlyB: Array<{ nodeName: string; mastery: number; examProb: number }>;
  avgMasteryA: number;
  avgMasteryB: number;
}

// ---------------------------------------------------------------------------
// 语音口述（本地 STT）
// ---------------------------------------------------------------------------

/** 本地语音转写引擎状态，主进程 → 渲染进程单向推送 */
export interface SttStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** 模型下载进度 0-1（loading 期间推送） */
  progress?: number;
  /** 错误信息（error 状态时） */
  error?: string;
}

// ---------------------------------------------------------------------------
// 通道映射
// ---------------------------------------------------------------------------

/** 请求/响应通道。新增能力时在此登记，两端自动获得类型约束。 */
export interface IpcInvokeMap {
  'app:getPaths': { req: void; res: AppPaths };
  'app:getVersion': { req: void; res: string };
  'window:getState': { req: void; res: { maximized: boolean } };
  'window:minimize': { req: void; res: void };
  'window:toggleMaximize': { req: void; res: { maximized: boolean } };
  'window:close': { req: void; res: void };

  'update:status': { req: void; res: UpdateStatus };
  'update:check': { req: void; res: UpdateStatus };
  /** 重启安装已下载的更新 */
  'update:install': { req: void; res: void };

  'config:get': { req: void; res: AppConfig };
  'config:update': { req: AppConfig; res: AppConfig };
  /** 密钥单独走 safeStorage，不进 config.json */
  'config:setSecret': { req: { ref: string; value: string }; res: void };
  'config:hasSecret': { req: { ref: string }; res: boolean };
  'config:deleteSecret': { req: { ref: string }; res: void };

  'llm:testTier': { req: { tier: LlmTier }; res: ProviderTestResult };
  /** 立即返回 streamId，内容通过 stream:* 事件推送 */
  'llm:chat': { req: ChatRequest; res: StreamStarted };
  'llm:cancel': { req: { streamId: string }; res: void };

  'search:query': { req: SearchRequest; res: SearchResponse };
  'search:fetchUrl': { req: FetchUrlRequest; res: FetchUrlResponse };
  'search:clearCache': { req: void; res: { removed: number } };

  'db:health': { req: void; res: { ok: boolean; tables: number; path: string } };

  'campaign:list': { req: void; res: CampaignSummary[] };
  'campaign:getOverview': { req: void; res: CampaignOverview };
  'campaign:compare': { req: { campaignIdA: string; campaignIdB: string }; res: CampaignCompareResult };
  'campaign:get': { req: { id: string }; res: CampaignDetail };
  'campaign:create': { req: CreateCampaignInput; res: Campaign };
  'campaign:update': { req: UpdateCampaignInput; res: Campaign };
  'campaign:delete': { req: { id: string }; res: void };

  'resume:list': { req: void; res: Resume[] };
  /** 创建简历时先用模型归类到固定模块；模型不可用退回规则识别，fallbackReason 说明这一点 */
  'resume:create': { req: CreateResumeInput; res: ResumeImportResult };
  'resume:update': { req: UpdateResumeInput; res: Resume };
  'resume:delete': { req: { id: string }; res: void };
  /** 弹出文件选择框导入简历（pdf/docx/txt/md），取消或失败时返回 null */
  'resume:importFile': { req: void; res: ResumeImportResult | null };
  'resume:exportPdf': { req: ResumeExportInput; res: ResumeExportResult };
  /** 用模型把内容重新归类到固定模块，返回 markdown 交给渲染进程预览后再保存 */
  'resume:aiStructure': { req: ResumeStructureInput; res: ResumeStructureResult };
  /** 基于整份简历与用户要求优化当前模块/条目的正文，返回文本交给渲染进程决定是否采用 */
  'resume:aiPolish': { req: ResumePolishInput; res: ResumePolishResult };

  'jobTarget:list': { req: void; res: JobTarget[] };
  'jobTarget:get': { req: { id: string }; res: JobTarget };
  'jobTarget:create': { req: CreateJobTargetInput; res: JobTarget };
  'jobTarget:update': { req: UpdateJobTargetInput; res: JobTarget };
  'jobTarget:delete': { req: { id: string }; res: void };

  'resumeVariant:list': {
    req: { jobTargetId?: string; sourceResumeId?: string } | void;
    res: ResumeVariantView[];
  };
  'resumeVariant:get': { req: { id: string }; res: ResumeVariantView };
  'resumeVariant:optimize': { req: OptimizeResumeInput; res: ResumeVariantView };
  'resumeVariant:update': { req: UpdateResumeVariantInput; res: ResumeVariantView };
  'resumeVariant:delete': { req: { id: string }; res: void };

  /** 解析 JD 并生成两层知识点树，进度通过 job:progress 推送 */
  'diagnosis:fromJd': { req: { campaignId: string }; res: DiagnosisJobStarted };
  /** 附加简历后重新交叉分析并更新覆盖类型 */
  'diagnosis:attachResume': { req: { campaignId: string; resumeId: string }; res: DiagnosisJobStarted };
  /** 懒加载细化某个节点 */
  'diagnosis:expandNode': { req: { nodeId: string }; res: DiagnosisJobStarted };
  /** 联网生成公司情报卡 */
  'diagnosis:fetchIntel': { req: { campaignId: string }; res: DiagnosisJobStarted };
  /** 手动粘贴面经，提取真题并修正考察频率 */
  'diagnosis:ingestReport': { req: IngestReportInput; res: IngestReportResult };
  /** 联网搜索面经并自动摄入 */
  'diagnosis:ingestWeb': { req: { campaignId: string }; res: IngestWebResult };
  /** 面经列表，带来源链接与抓取时间 */
  'diagnosis:listReports': { req: { campaignId: string }; res: InterviewReportView[] };

  'node:update': { req: UpdateNodeInput; res: KnowledgeNode };
  'node:delete': { req: { id: string }; res: void };
  'node:create': { req: CreateNodeInput; res: KnowledgeNode };

  'edge:list': { req: { campaignId: string }; res: NodeEdgeView[] };
  'edge:create': { req: CreateEdgeInput; res: NodeEdgeView };
  'edge:delete': { req: { id: string }; res: void };

  /** 主动提示：盲区、反复答错、雷区未准备、拖延、反复追问 */
  'insight:nudges': { req: { campaignId: string }; res: Nudge[] };
  /** 历史即传感器：把行为信号回写成排序输入 */
  'insight:applyHistory': { req: { campaignId: string }; res: HistorySignalResult };

  'plan:generate': { req: PlanGenerateInput; res: PlanGenerateResult };
  'plan:listTodayCampaigns': { req: void; res: TodayCampaignOption[] };
  'plan:getToday': { req: { campaignId?: string; date?: string }; res: TodayPlan | null };
  'plan:deferToday': { req: { campaignId: string }; res: { deferred: number } };
  'plan:listDates': { req: { campaignId: string }; res: PlanDateOption[] };

  'task:complete': { req: { taskId: string; actualMinutes?: number }; res: TaskView };
  'task:skip': { req: { taskId: string }; res: TaskView };
  'task:reorder': { req: { planDayId: string; taskIds: string[] }; res: void };
  'task:move': { req: { taskId: string; date: string }; res: void };
  'task:delete': { req: { taskId: string }; res: void };
  'task:add': { req: TaskAddInput; res: { taskId: string } };
  'task:setMinutes': { req: { taskId: string; estMinutes: number }; res: void };

  'explain:get': { req: ExplainGetInput; res: Explanation | null };
  'explain:generate': { req: ExplainGenerateInput; res: Explanation };
  'explain:fallback': { req: { nodeId: string; instruction?: string }; res: Explanation };
  'explain:update': { req: ExplainUpdateInput; res: Explanation };
  'explain:elaborate': { req: ExplainElaborateInput; res: ExplainElaborateResult };
  'explain:rewrite': { req: ExplainRewriteInput; res: ExplainRewriteResult };

  'quiz:draft': { req: { nodeId: string }; res: QuizDraftResult };
  'quiz:updateDraft': { req: QuizUpdateDraftInput; res: QuizDraftResult };
  'quiz:question': { req: { nodeId: string }; res: QuizQuestionResult };
  'quiz:answer': { req: QuizAnswerInput; res: QuizAnswerResult };
  'quiz:submit': { req: QuizSubmitInput; res: QuizSubmitResult };

  'repo:gitStatus': { req: void; res: GitStatus };
  'repo:list': { req: void; res: Repo[] };
  'repo:get': { req: { id: string }; res: Repo };
  'repo:add': { req: RepoAddInput; res: DiagnosisJobStarted };
  'repo:delete': { req: { id: string }; res: RepoDeleteResult };
  'repo:readFile': { req: RepoReadFileInput; res: RepoReadFileResult };
  'speech:save': { req: SpeechSaveInput; res: SpeechSnippet };
  'speech:saveFromNode': { req: SpeechSaveFromNodeInput; res: SpeechSnippet };
  'speech:saveFromDesign': { req: SpeechSaveFromDesignInput; res: SpeechSnippet };
  'speech:saveFromQuiz': { req: SpeechSaveFromQuizInput; res: SpeechSnippet };
  'speech:list': { req: void; res: SpeechSnippetView[] };
  'speech:listForSource': { req: SpeechListForSourceInput; res: SpeechSnippet[] };
  'speech:update': { req: SpeechUpdateInput; res: SpeechSnippet };
  'speech:delete': { req: { id: string }; res: void };
  'speech:export': { req: SpeechExportInput; res: SpeechExportResult };

  'design:case': {
    req: {
      campaignId: string;
      interviewType?: MockInterviewType;
      interviewLanguage?: MockInterviewLanguage;
      force?: boolean;
    };
    res: DesignCaseResult;
  };
  'design:submit': { req: DesignSubmitInput; res: DesignSubmitResult };
  'design:updateAnswers': { req: DesignUpdateAnswersInput; res: DesignCaseResult };
  'design:generateAnswer': { req: DesignGenerateAnswerInput; res: DesignGenerateAnswerResult };
  'design:elaborate': { req: DesignElaborateInput; res: DesignElaborateResult };

  'annotation:list': { req: { targetType: AnnotationTarget; targetId: string }; res: Annotation[] };
  /** 一场面试下五类目标的全部标记 */
  'annotation:listForCampaign': { req: { campaignId: string }; res: AnnotationView[] };
  /** 一个仓库下的代码位置标记 */
  'annotation:listForRepo': { req: { repoId: string }; res: AnnotationView[] };
  'annotation:create': { req: AnnotationCreateInput; res: Annotation };
  'annotation:delete': { req: { id: string }; res: void };
  'annotation:toggleBookmark': { req: AnnotationToggleInput; res: { bookmarked: boolean } };
  /** 标记代码位置前先落一条 code_ref，返回其 id */
  'codeRef:ensure': { req: EnsureCodeRefInput; res: { id: string } };

  'session:list': {
    req: { kind?: SessionKind; nodeId?: string; limit?: number };
    res: SessionSummary[];
  };
  'session:getMessages': { req: { sessionId: string }; res: SessionMessageView[] };
  'session:getMessagesForNode': { req: { nodeId: string }; res: SessionMessageView[] };
  'session:search': { req: { query: string; limit?: number }; res: SessionSearchHit[] };
  'session:delete': { req: { sessionId: string }; res: void };
  'session:deleteForNode': { req: { nodeId: string }; res: void };
  'session:bindNode': {
    req: { sessionId: string; nodeId: string; campaignId?: string };
    res: void;
  };

  'sync:status': { req: void; res: SyncStatus };
  /** 启动配对并返回二维码载荷 */
  'sync:beginPairing': { req: void; res: { port: number; payload: PairingPayload | null } };
  'sync:cancelPairing': { req: void; res: void };
  'sync:listPeers': { req: void; res: SyncStatus['peers'] };
  'sync:removePeer': { req: { deviceId: string }; res: void };
  'sync:listRuns': { req: { limit?: number } | void; res: SyncRunSummary[] };
  /** 某次同步里按更新时间自动覆盖掉的旧值，供核对是否需要从备份还原 */
  'sync:listOverwrites': { req: { runId: string }; res: FieldOverwrite[] };
  /** 本机 backups/ 目录下的全部整库快照，不只是能对上某次同步的那几份 */
  'sync:listBackups': { req: void; res: BackupInfo[] };
  /** 手动留一份现场，重装或大动作之前用 */
  'sync:createBackup': { req: void; res: BackupInfo };
  'sync:rollback': { req: { backupFile: string }; res: void };
  'sync:deleteBackup': { req: { backupFile: string }; res: void };

  /** 查询本地语音转写引擎状态（模型是否就绪/加载进度/错误） */
  'stt:status': { req: void; res: SttStatus };
  /** 本地离线转写：16kHz 单声道 Float32 PCM → 文本 */
  'stt:transcribe': { req: { audio: Float32Array }; res: { text: string } };
}

/** 主进程 → 渲染进程的单向推送 */
export interface IpcEventMap {
  'window:state': { maximized: boolean };
  'stream:delta': StreamDelta;
  'stream:tool': StreamToolCall;
  'stream:done': StreamDone;
  'stream:error': StreamError;
  'job:progress': JobProgress;
  'update:status': UpdateStatus;
  'sync:paired': { deviceId: string; displayName: string };
  'sync:finished': {
    runId: string;
    peerDeviceId: string;
    appliedCount: number;
    overwriteCount: number;
  };
  /** 两端版本不同，已拒绝本轮同步（没有动数据） */
  'sync:versionMismatch': {
    peerName: string;
    /** 对端上报的版本；老版本手机端不带版本号时为 null */
    peerVersion: string | null;
    desktopVersion: string;
  };
  /** 语音模型加载/下载进度推送 */
  'stt:status': SttStatus;
}

export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcEventChannel = keyof IpcEventMap;

export type IpcReq<C extends IpcInvokeChannel> = IpcInvokeMap[C]['req'];
export type IpcRes<C extends IpcInvokeChannel> = IpcInvokeMap[C]['res'];

/** 供 preload 做白名单校验，避免渲染进程调用未登记的通道 */
export const IPC_INVOKE_CHANNELS = [
  'app:getPaths',
  'app:getVersion',
  'window:getState',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'update:status',
  'update:check',
  'update:install',
  'config:get',
  'config:update',
  'config:setSecret',
  'config:hasSecret',
  'config:deleteSecret',
  'llm:testTier',
  'llm:chat',
  'llm:cancel',
  'search:query',
  'search:fetchUrl',
  'search:clearCache',
  'db:health',
  'campaign:list',
  'campaign:getOverview',
  'campaign:compare',
  'campaign:get',
  'campaign:create',
  'campaign:update',
  'campaign:delete',
  'resume:list',
  'resume:create',
  'resume:update',
  'resume:delete',
  'resume:importFile',
  'resume:exportPdf',
  'resume:aiStructure',
  'resume:aiPolish',
  'jobTarget:list',
  'jobTarget:get',
  'jobTarget:create',
  'jobTarget:update',
  'jobTarget:delete',
  'resumeVariant:list',
  'resumeVariant:get',
  'resumeVariant:optimize',
  'resumeVariant:update',
  'resumeVariant:delete',
  'diagnosis:fromJd',
  'diagnosis:attachResume',
  'diagnosis:expandNode',
  'diagnosis:fetchIntel',
  'diagnosis:ingestReport',
  'diagnosis:ingestWeb',
  'diagnosis:listReports',
  'node:update',
  'node:delete',
  'node:create',
  'edge:list',
  'edge:create',
  'edge:delete',
  'insight:nudges',
  'insight:applyHistory',
  'plan:generate',
  'plan:listTodayCampaigns',
  'plan:getToday',
  'plan:deferToday',
  'plan:listDates',
  'task:complete',
  'task:skip',
  'task:reorder',
  'task:move',
  'task:delete',
  'task:add',
  'task:setMinutes',
  'explain:get',
  'explain:generate',
  'explain:fallback',
  'explain:update',
  'explain:elaborate',
  'explain:rewrite',
  'quiz:draft',
  'quiz:updateDraft',
  'quiz:question',
  'quiz:answer',
  'quiz:submit',
  'repo:gitStatus',
  'repo:list',
  'repo:get',
  'repo:add',
  'repo:delete',
  'repo:readFile',
  'speech:save',
  'speech:saveFromNode',
  'speech:saveFromDesign',
  'speech:saveFromQuiz',
  'speech:list',
  'speech:listForSource',
  'speech:update',
  'speech:delete',
  'speech:export',
  'design:case',
  'design:submit',
  'design:updateAnswers',
  'design:generateAnswer',
  'design:elaborate',
  'annotation:list',
  'annotation:listForCampaign',
  'annotation:listForRepo',
  'annotation:create',
  'annotation:delete',
  'annotation:toggleBookmark',
  'codeRef:ensure',
  'session:list',
  'session:getMessages',
  'session:getMessagesForNode',
  'session:search',
  'session:delete',
  'session:deleteForNode',
  'session:bindNode',
  'sync:status',
  'sync:beginPairing',
  'sync:cancelPairing',
  'sync:listPeers',
  'sync:removePeer',
  'sync:listRuns',
  'sync:listOverwrites',
  'sync:listBackups',
  'sync:createBackup',
  'sync:rollback',
  'sync:deleteBackup',
  'stt:status',
  'stt:transcribe',
] as const satisfies readonly IpcInvokeChannel[];

export const IPC_EVENT_CHANNELS = [
  'window:state',
  'stream:delta',
  'stream:tool',
  'stream:done',
  'stream:error',
  'job:progress',
  'update:status',
  'sync:paired',
  'sync:finished',
  'sync:versionMismatch',
  'stt:status',
] as const satisfies readonly IpcEventChannel[];

/**
 * preload 注入到 window 上的桥接对象。
 * 渲染进程通过它调用主进程，不直接接触 ipcRenderer。
 */
export interface IpcBridge {
  invoke<C extends IpcInvokeChannel>(channel: C, payload: IpcReq<C>): Promise<IpcRes<C>>;
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void;
}

/**
 * 首帧之前就要用上、等不了一次 IPC 往返的值。
 * 由主进程在建窗时按 config.json 填好，preload 同步注入到 window。
 */
export interface RendererBootstrap {
  theme: UiTheme;
}
