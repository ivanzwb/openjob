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
import type { LlmRoleView } from './llm/roles';
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
  CandidateEvidence,
  Citation,
  CompanyIntel,
  Explanation,
  InterviewReport,
  JobTarget,
  KnowledgeNode,
  PlanDay,
  QuizAttempt,
  Resume,
  SpeechSnippet,
  Task,
  Annotation,
  JdParsed,
  RoleProfile,
} from './entities';
import type {
  BackupInfo,
  FieldOverwrite,
  PairingPayload,
  SyncRunSummary,
  SyncStatus,
} from './sync';
import type {
  ArtifactSchemaRef,
  ClientCapabilityView,
  InstalledPlugin,
} from './plugins/clientView';
import type { PluginType } from './enums';
import type { CampaignRuntimeDescriptor, ClientPlatform, RolePack } from './plugins/types';
import type { PluginPermission } from './plugins/permissions';
import type {
  LibrarySnippet,
  PluginArtifact,
  WorkspaceEntry,
  WorkspaceFetchResult,
  WorkspaceGrepMatch,
  WorkspaceSnapshot,
  WorkspaceSymbolsResult,
} from './plugins/pluginRuntime/host';
import type { EvidenceProposal, EvidenceScope } from './evidence/types';
import type {
  PracticeAttempt,
  PracticeAttemptQuery,
  PracticeDimensionScore,
  PracticeEvaluation,
  PracticeEvaluationInput,
  PracticeSession,
  PracticeSessionInput,
  PracticeTurn,
  PracticeTurnInput,
} from './practice/types';
import type {
  Story,
  StoryDeliveryDuration,
  StoryDeliveryView,
  StoryInput,
  StoryPatch,
} from './story/types';

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

/** 外置插件的可信程度。unknown-signer 需要用户显式确认后才装。 */
export type PluginTrust = 'first-party' | 'unknown-signer' | 'unsigned' | 'tampered';

/** 装上了但没生效的包。缺这份清单，用户只能看到「岗位列表里没有它」。 */
export interface PluginRejectionView {
  dir: string;
  reason: string;
  detail: string;
}

export interface PluginInventoryView {
  /**
   * 盘上真正装着的包（userData/plugins 下扫到的）。
   *
   * 刻意**不含**按岗位包内嵌声明合成出来的能力条目：那条是运行时拿来做能力引用与权限
   * 契约的视图，内容本来就归岗位包所有，所以展示时并进对应的岗位包，不单独成一个包。
   */
  installed: Array<{
    id: string;
    version: string;
    type: PluginType;
    displayName: string;
    trust: PluginTrust;
    /** 代码入口；为空表示纯声明式，没有启用/停用这回事 */
    main: string | null;
  }>;
  rejected: PluginRejectionView[];
}

/**
 * 安装结果。
 *
 * 一台设备只装一个插件包，所以 `one-plugin-limit` 表示本机已经装了别的插件：
 * 调用方要引导用户先卸载，而不是让他在两个包之间反复重试。
 */
export type PluginInstallResult =
  | { ok: true; id: string; version: string; trust: PluginTrust }
  | { ok: false; code: string; detail: string };

/**
 * 更新源里可安装的一个插件包。
 *
 * 元数据取自包自己的 manifest.json——权限要在**装之前**就摆给用户看，等装完才知道
 * 这个包要读什么，等于把确认变成了补告。
 */
export interface PluginCatalogEntry {
  id: string;
  version: string;
  /** 只有读到 manifest 才知道类型；没读到时为 null */
  type: PluginType | null;
  displayName: string;
  description: string;
  permissions: string[];
  /** 包体字节数；只认得出文件名时为 null */
  bytes: number | null;
  /** 从哪个 release 读到的，让用户知道东西来自哪一版 */
  releaseTag: string | null;
  /** manifest 是否真的读到了。读不到时 displayName 退化成 id，界面要少说两句而不是编 */
  described: boolean;
}

/** 插件清单。error 非空时 entries 为空，message 说明用户能做什么。 */
export interface PluginCatalogView {
  /** 实际读取的地址：清单拉不到时，用户能自己核对更新源填得对不对 */
  source: string;
  fetchedAt: number;
  entries: PluginCatalogEntry[];
  error: { kind: 'unreachable' | 'not-published' | 'malformed'; message: string } | null;
}

export interface AppPaths {
  userData: string;
  dbFile: string;
  cacheDir: string;
  backupsDir: string;
  /** 外置插件包的安装位置，每个包一个 `<id>@<version>` 子目录 */
  pluginsDir: string;
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
  /**
   * 由角色决定用哪个 provider 和 model，调用方不直接指定模型。
   *
   * 省略时落 main 档。
   */
  role?: LlmRole;
  messages: ChatMessage[];
  /** 开启后 Agent 可自行决定是否联网检索 */
  allowWebSearch?: boolean;
  /** 关闭时不注入任何工具（图谱/联网等），仅多轮对话 */
  allowTools?: boolean;
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
  /**
   * 岗位相关的检索传 campaignId：检索配置会合入该 Campaign 岗位包的 sourcePolicy
   * （插入点 C，覆盖顺序 core 默认 < 岗位包 < 用户设置）。不传则只用全局配置。
   */
  campaignId?: string;
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
  /**
   * 绑定的母版简历。不传时按默认规则取：目标岗位有优化派生版 → 派生版的母版，
   * 否则最新母版（规则见 @core/resume/campaignBinding）。
   */
  resumeId?: string | null;
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
  /** 任务挂的材料的展示名，取自材料行的 label；没有材料或取不到时为 null。 */
  materialLabel: string | null;
  /** 任务名，取自岗位包的任务模板声明；宿主不认识任务种类，未声明时为 null。 */
  kindLabel: string | null;
  /** 承担该任务页面的包页面 id；null 表示用宿主的考点视图。 */
  pageId: string | null;
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
  /** 手动新建任务时挂的材料类型与标识；材料内容对宿主不透明。 */
  materialKind?: string | null;
  materialId?: string | null;
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
  /** 还没提交的作答，只留在本机，见 sync/tables.ts 的 deviceLocal */
  answerDraftMd: string | null;
}

export interface QuizUpdateDraftInput {
  nodeId: string;
  questionMd?: string | null;
  recommendedAnswerMd?: string | null;
  answerDraftMd?: string | null;
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

export interface SpeechSaveFromNodeInput {
  nodeId: string;
  contentMd: string;
  tier?: ExplanationTier;
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
  /** 话术可追溯到的备考（JD）；无法归属（如纯源码话术）时为 null */
  campaignId: string | null;
  /** 分组标题：公司 · 岗位 */
  campaignLabel: string | null;
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
// 插件运行时与本机能力
// ---------------------------------------------------------------------------

/**
 * Campaign 当前激活的运行配置。
 *
 * descriptor 是 resolver 解析结果的只读快照，桌面和手机都只消费它，
 * 不各自展开插件依赖；精确版本以同 revision 的 binding 为权威。
 */
export interface CampaignRuntimeView {
  descriptor: CampaignRuntimeDescriptor;
  /** 对应的 campaign_plugin_binding revision。 */
  revision: number;
  roleProfile: RoleProfile | null;
}

export interface SetRoleProfileInput {
  campaignId: string;
  roleFamily: string;
  rolePackId: string;
  level?: string | null;
  industryPackId?: string | null;
  location?: string | null;
  /** 默认 zh。 */
  interviewLanguage?: string;
  /** 0–1，自动识别的置信度，默认 1（用户显式选择）。 */
  confidence?: number;
  /** 默认 true；自动识别待确认时传 false。 */
  userConfirmed?: boolean;
  /** 额外显式启用的能力插件；岗位包声明的可选依赖由 resolver 自动展开。 */
  capabilityIds?: string[];
}

export interface ClientCapabilityViewRequest {
  campaignId: string;
  platform: ClientPlatform;
  /** 手机端传本机已安装清单；不传时按调用端内置清单计算。 */
  installed?: InstalledPlugin[];
  /** 需要判断能否解析的 artifact；未知 schema 一律只读。 */
  artifacts?: ArtifactSchemaRef[];
}

// ---------------------------------------------------------------------------
// 候选人证据
// ---------------------------------------------------------------------------

/**
 * 证据抽取的入参只有 campaignId。
 *
 * 刻意不让调用方传文档：能进抽取的是哪几份文档，是这个任务的核心边界，
 * 交给渲染进程或手机端去挑，等于把「JD 不能变成证据」放到了两个客户端各自的
 * 代码里再赌一次。主进程按 Campaign 取数，JD 与公司情报只作为相关度排序输入。
 */
export interface EvidenceExtractRequest {
  campaignId: string;
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
  /**
   * 本机有效的 LLM 角色清单：基础角色 + 已装岗位包声明的角色。
   *
   * 设置页的「角色映射」按它渲染，所以没装某个岗位包时，那个岗位特有的角色
   * 不会出现在列表里。角色归包所有，基础包不认识具体岗位的角色。
   */
  'config:listLlmRoles': { req: void; res: LlmRoleView[] };
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

  /** 本机已安装的插件清单（内置 + 外置），不代表任一 Campaign 已启用 */
  'plugin:listInstalled': { req: void; res: InstalledPlugin[] };
  /** 外置插件的装载结果，含装不上的包与原因 */
  'plugin:inventory': { req: void; res: PluginInventoryView };
  /** 主进程弹文件选择框，渲染层不传路径。返回 null 表示用户取消。 */
  'plugin:install': {
    req: {
      trustUnknownSigner?: boolean;
      overwrite?: boolean;
      /** 用户在「升级前旧战役数据可能丢失」提示上点了继续，跳过数据丢失把关 */
      confirmDataLoss?: boolean;
    };
    res: PluginInstallResult | null;
  };
  'plugin:uninstall': { req: { id: string; version: string }; res: { removed: boolean } };
  /**
   * 删掉一个「装在本机但没有生效」的插件目录。
   *
   * 扫描拒掉的包（签名者不受信任、被改动、读不出来……）不进安装清单，于是没有
   * id@version 可以走 plugin:uninstall，但目录还留在盘上、设置页会一直报错。这里只传
   * 目录名，主进程再自证它确实是 pluginsDir 的直接子目录——渲染层能传路径的话，
   * 主进程就成了任意目录删除器。
   */
  'plugin:removeRejectedDir': { req: { dir: string }; res: { removed: boolean } };
  /**
   * 从更新源拉取可安装插件清单。
   *
   * 来源与自动更新同一处：更新源填了就用它，留空走官方 GitHub Release。拉不到清单
   * 是常态（离线、镜像不通、还没发过插件），所以走 PluginCatalogView.error 返回，
   * 不抛错——面板要把原因说出来，而不是留一片空白。
   */
  'plugin:listAvailable': { req: void; res: PluginCatalogView };
  /**
   * 从更新源装一个插件包。渲染层只给 id@version，不给地址：下载与校验都在主进程，
   * 渲染层能指定 URL 的话，主进程就成了任意地址的下载器。
   */
  'plugin:installFromCatalog': {
    req: {
      id: string;
      version: string;
      trustUnknownSigner?: boolean;
      /** 用户在「升级前旧战役数据可能丢失」提示上点了继续 */
      confirmDataLoss?: boolean;
    };
    res: PluginInstallResult;
  };
  /**
   * 按精确版本取一份已安装的岗位包数据，没装返回 null。
   *
   * 存在的理由是手机端：它不安装插件包，岗位包只能从已配对的桌面端要一份过来
   * （见 `shared/plugins/package/rolePackTransfer.ts`）。岗位包是纯数据，传的东西
   * 不会在任何一端执行。
   */
  'plugin:getRolePack': { req: { id: string; version: string }; res: RolePack | null };
  /** 代码插件（v3）：取入口源码与 Webview 资产；非代码插件返回 null */
  'plugin:getEntrySource': {
    req: { id: string; version: string };
    res: { source: string; uiAssets: Record<string, string> } | null;
  };
  /** 代码插件私有 KV（§7.9 ctx.storage）：与主库物理隔离，按 pluginId 分文件 */
  'pluginRuntime:storage.get': { req: { pluginId: string; key: string }; res: string | null };
  'pluginRuntime:storage.set': { req: { pluginId: string; key: string; value: string }; res: void };
  'pluginRuntime:storage.delete': { req: { pluginId: string; key: string }; res: void };
  /**
   * 代码插件声明的数据集合（阶段 3 B2）：宿主建通用承载表，内容对宿主不透明。
   *
   * 值一律是字符串，由包自己序列化与反序列化。集合名必须是调用方 manifest 声明过的，
   * 否则按「未声明的数据集合」拒；每次读写都按 pluginId 收窄。
   */
  'pluginRuntime:data.get': {
    req: { pluginId: string; collection: string; key: string };
    res: string | null;
  };
  'pluginRuntime:data.put': {
    req: { pluginId: string; collection: string; key: string; value: string };
    res: void;
  };
  'pluginRuntime:data.delete': {
    req: { pluginId: string; collection: string; key: string };
    res: void;
  };
  /** 结果被 limit 上限截断，调用方按 prefix 翻页 */
  'pluginRuntime:data.list': {
    req: { pluginId: string; collection: string; prefix?: string; limit?: number };
    res: Array<{ key: string; value: string }>;
  };
  'pluginRuntime:data.count': { req: { pluginId: string; collection: string }; res: number };
  /** 代码插件受控 LLM 补全：同网关同审计，promptId 记为 plugin:<id> */
  'pluginRuntime:llm.complete': {
    req: { pluginId: string; version: string; system: string; user: string; role?: LlmRole };
    res: unknown;
  };
  /** 只读指定 Campaign 的已确认证据（需 evidence:read-confirmed 权限） */
  'pluginRuntime:evidence.listConfirmed': {
    req: { pluginId: string; campaignId: string };
    res: CandidateEvidence[];
  };
  /**
   * 代码插件的**工作区原语**（分发计划 §11.2）：本包工作区内的读 / 写 / 删 / 遍历 /
   * glob / grep / 文本快照。宿主实现在主进程，每次调用都经权限网关校验 `filesystem:workspace`；
   * 路径解析后越出本包工作区根即拒（绝对路径 / `..` / 符号链接逸出一致处理）。
   * 只传相对路径，主进程不接收调用方给的绝对路径。
   */
  'pluginRuntime:workspace.read': {
    req: { pluginId: string; path: string; startLine?: number; endLine?: number };
    res: string;
  };
  'pluginRuntime:workspace.write': {
    req: { pluginId: string; path: string; content: string };
    res: void;
  };
  'pluginRuntime:workspace.delete': { req: { pluginId: string; path: string }; res: void };
  'pluginRuntime:workspace.list': { req: { pluginId: string; path: string }; res: WorkspaceEntry[] };
  'pluginRuntime:workspace.glob': { req: { pluginId: string; pattern: string }; res: string[] };
  'pluginRuntime:workspace.grep': {
    req: { pluginId: string; pattern: string; path?: string };
    res: WorkspaceGrepMatch[];
  };
  /**
   * 工作区原语的**远端拉取**（分发计划 §11.2）：把公开的 https 仓库拉到本包工作区。
   * 需要 `network:fetch` 与 `filesystem:workspace` 两项声明；目标目录已存在时的更新语义
   * 见 `ctx.workspace.fetch` 的说明。
   */
  'pluginRuntime:workspace.fetch': {
    req: { pluginId: string; url: string; dir?: string };
    res: WorkspaceFetchResult;
  };
  'pluginRuntime:workspace.snapshot': {
    req: { pluginId: string; path: string };
    res: WorkspaceSnapshot | null;
  };
  /**
   * 工作区原语的**批量符号提取**（分发计划 §11.4）：一次传入一批工作区内的相对路径，
   * 拿回每文件的符号与摘要。解析在宿主侧常驻的 tree-sitter 引擎里做，包沙箱只拿结果；
   * 传 `digests`（上一次的 sha256）可做增量，摘要没变的文件不再回符号。
   */
  'pluginRuntime:workspace.symbols': {
    req: { pluginId: string; paths: string[]; digests?: Record<string, string> };
    res: WorkspaceSymbolsResult;
  };
  /**
   * 代码插件的 **artifact 原语**（分发计划 §11.2）：读入用户显式选择的一个文件（表格 / 文档）。
   * 请求里**没有路径**——文件选择器弹在主进程，渲染层拿不到也就传不了本机路径；
   * 每次调用都经权限网关校验 `artifact:read`，选择器取消即拒。
   */
  'pluginRuntime:artifact.read': {
    req: { pluginId: string };
    res: PluginArtifact;
  };
  /**
   * 代码插件的 **话术库原语**：把一段文字存进用户的话术库（`speech_snippet`），并按包自己
   * 起的 sourceKind 取回自己存过的那几条。宿主把 sourceKind 原样写进 source_type、把
   * sourceLabel 存进既有的来源标签机制，不理解岗位语义；每次调用都经权限网关校验
   * `library:write`（声明即上限，与其它原语同款）。
   */
  'pluginRuntime:library.saveSnippet': {
    req: {
      pluginId: string;
      text: string;
      sourceKind: string;
      sourceLabel: string;
      tier?: ExplanationTier;
    };
    res: LibrarySnippet;
  };
  'pluginRuntime:library.listSnippets': {
    req: { pluginId: string; sourceKind?: string; limit?: number };
    res: LibrarySnippet[];
  };
  /** 代码插件清单（含启用状态）：设置页展示与激活门槛共用 */
  'pluginRuntime:list': {
    req: void;
    res: Array<{
      id: string;
      version: string;
      displayName: string;
      description: string;
      permissions: PluginPermission[];
      main: string;
      api: string;
      enabled: boolean;
    }>;
  };
  /** 启用/停用：启用要求用户已在界面上确认权限清单 */
  'pluginRuntime:setEnabled': { req: { id: string; enabled: boolean }; res: void };

  'campaign:list': { req: void; res: CampaignSummary[] };
  'campaign:getOverview': { req: void; res: CampaignOverview };
  'campaign:compare': { req: { campaignIdA: string; campaignIdB: string }; res: CampaignCompareResult };
  'campaign:get': { req: { id: string }; res: CampaignDetail };
  'campaign:create': { req: CreateCampaignInput; res: Campaign };
  'campaign:update': { req: UpdateCampaignInput; res: Campaign };
  'campaign:delete': { req: { id: string }; res: void };
  /** 尚未回填/激活的 Campaign 返回 null，调用方走旧执行路径 */
  'campaign:getRuntimeDescriptor': { req: { campaignId: string }; res: CampaignRuntimeView | null };
  /** 写岗位意图并激活新的 binding revision；解析失败时不写任何一行 */
  'campaign:setRoleProfile': { req: SetRoleProfileInput; res: CampaignRuntimeView };
  /** 纯视图计算：只读 descriptor 与本机安装清单，不修改 Campaign binding */
  'campaign:getClientCapabilityView': {
    req: ClientCapabilityViewRequest;
    res: ClientCapabilityView | null;
  };

  'resume:list': { req: void; res: Resume[] };
  /** 创建简历时先用模型归类到固定模块；模型不可用退回规则识别，fallbackReason 说明这一点 */
  'resume:create': { req: CreateResumeInput; res: ResumeImportResult };
  'resume:update': { req: UpdateResumeInput; res: Resume };
  'resume:delete': { req: { id: string }; res: void };
  /** 复制一份：正文/模板/寸照原样保留，名字加「副本」，不走模型重排 */
  'resume:duplicate': { req: { id: string }; res: Resume };
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
  /** 复制一份优化版：内容/模板/寸照原样保留，名字加「副本」 */
  'resumeVariant:duplicate': { req: { id: string }; res: ResumeVariantView };

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

  /**
   * 通用练习协议。
   *
   * 与上面的 quiz:* 并存而不是取代它：旧通道要保持可用一个发布周期，手机端升级
   * 不同步时仍然走旧链路。
   */
  'practice:createSession': { req: PracticeSessionInput; res: PracticeSession };
  'practice:getSession': { req: { sessionId: string }; res: PracticeSession | null };
  'practice:nextTurn': { req: PracticeTurnInput; res: PracticeTurn };
  'practice:evaluate': { req: PracticeEvaluationInput; res: PracticeEvaluation };
  /** 三种来源合并的练习历史；quiz 行为只读投影 */
  'practice:listAttempts': { req: PracticeAttemptQuery; res: PracticeAttempt[] };
  /** 单条练习记录的逐维度分数、量规锚点与原回答引用 */
  'practice:listScores': { req: { attemptId: string }; res: PracticeDimensionScore[] };

  'speech:saveFromNode': { req: SpeechSaveFromNodeInput; res: SpeechSnippet };
  'speech:saveFromQuiz': { req: SpeechSaveFromQuizInput; res: SpeechSnippet };
  'speech:list': { req: void; res: SpeechSnippetView[] };
  'speech:listForSource': { req: SpeechListForSourceInput; res: SpeechSnippet[] };
  'speech:update': { req: SpeechUpdateInput; res: SpeechSnippet };
  'speech:delete': { req: { id: string }; res: void };
  'speech:export': { req: SpeechExportInput; res: SpeechExportResult };

  'annotation:list': { req: { targetType: AnnotationTarget; targetId: string }; res: Annotation[] };
  /** 一场面试下全部目标的标记 */
  'annotation:listForCampaign': { req: { campaignId: string }; res: AnnotationView[] };
  'annotation:create': { req: AnnotationCreateInput; res: Annotation };
  'annotation:delete': { req: { id: string }; res: void };
  'annotation:toggleBookmark': { req: AnnotationToggleInput; res: { bookmarked: boolean } };

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

  /** 从本战役的候选人文档抽取待确认证据；纯计算，不落库 */
  'evidence:extract': { req: EvidenceExtractRequest; res: EvidenceProposal[] };
  /** 已确认证据。个人化回答只能用这个通道的结果 */
  'evidence:listConfirmed': { req: EvidenceScope; res: CandidateEvidence[] };
  'evidence:listProposed': { req: EvidenceScope; res: CandidateEvidence[] };
  /** 引文在候选人文档里定位不上时拒绝写入，不返回部分结果 */
  'evidence:propose': { req: EvidenceProposal; res: CandidateEvidence };
  'evidence:confirm': { req: { id: string }; res: CandidateEvidence };
  'evidence:reject': { req: { id: string }; res: void };

  /**
   * Story 工作台。
   *
   * create / revise 在没有已确认证据时直接拒绝，不返回部分结果；createDelivery 的
   * 入参只有 Story id 与时长，三档口述因此不可能各带一份事实进来。
   */
  'story:list': { req: { campaignId: string }; res: Story[] };
  'story:get': { req: { id: string }; res: Story | null };
  'story:create': { req: StoryInput; res: Story };
  'story:revise': { req: { id: string; patch: StoryPatch }; res: Story };
  /** 删 Story 只删它自己和它的口述话术，candidate_evidence 一行不动 */
  'story:delete': { req: { id: string }; res: void };
  'story:createDelivery': {
    req: { id: string; duration: StoryDeliveryDuration };
    res: SpeechSnippet;
  };
  /** 已生成的口述版本，带正文与事实集合指纹 */
  'story:listDeliveries': { req: { id: string }; res: StoryDeliveryView[] };
}

/** 主进程 → 渲染进程的单向推送 */
export interface IpcEventMap {
  'window:state': { maximized: boolean };
  'stream:delta': StreamDelta;
  'stream:tool': StreamToolCall;
  'stream:done': StreamDone;
  'stream:error': StreamError;
  'job:progress': JobProgress;
  /** 代码插件事件（§7.9）：简历附加完成 */
  'campaign:attached': { campaignId: string };
  /** 代码插件事件：能力启停变化 */
  'campaign:capability-changed': { campaignId: string };
  /** 代码插件事件：一次练习评分完成 */
  'practice:completed': { campaignId: string; formatId: string; totalScore: number };
  'update:status': UpdateStatus;
  'sync:paired': { deviceId: string; displayName: string };
  'sync:finished': {
    runId: string;
    peerDeviceId: string;
    appliedCount: number;
    overwriteCount: number;
    /** 本端因引用不存在的父行（父行已删除或从未存在）而跳过的变更数 */
    skippedCount: number;
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
  'config:listLlmRoles',
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
  'plugin:listInstalled',
  'plugin:inventory',
  'plugin:install',
  'plugin:uninstall',
  'plugin:removeRejectedDir',
  'plugin:listAvailable',
  'plugin:installFromCatalog',
  'plugin:getRolePack',
  'plugin:getEntrySource',
  'pluginRuntime:storage.get',
  'pluginRuntime:storage.set',
  'pluginRuntime:storage.delete',
  'pluginRuntime:data.get',
  'pluginRuntime:data.put',
  'pluginRuntime:data.delete',
  'pluginRuntime:data.list',
  'pluginRuntime:data.count',
  'pluginRuntime:llm.complete',
  'pluginRuntime:evidence.listConfirmed',
  'pluginRuntime:workspace.read',
  'pluginRuntime:workspace.write',
  'pluginRuntime:workspace.delete',
  'pluginRuntime:workspace.list',
  'pluginRuntime:workspace.glob',
  'pluginRuntime:workspace.grep',
  'pluginRuntime:workspace.snapshot',
  'pluginRuntime:workspace.fetch',
  'pluginRuntime:workspace.symbols',
  'pluginRuntime:artifact.read',
  'pluginRuntime:library.saveSnippet',
  'pluginRuntime:library.listSnippets',
  'pluginRuntime:list',
  'pluginRuntime:setEnabled',
  'campaign:list',
  'campaign:getOverview',
  'campaign:compare',
  'campaign:get',
  'campaign:create',
  'campaign:update',
  'campaign:delete',
  'campaign:getRuntimeDescriptor',
  'campaign:setRoleProfile',
  'campaign:getClientCapabilityView',
  'resume:list',
  'resume:create',
  'resume:update',
  'resume:delete',
  'resume:duplicate',
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
  'resumeVariant:duplicate',
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
  'practice:createSession',
  'practice:getSession',
  'practice:nextTurn',
  'practice:evaluate',
  'practice:listAttempts',
  'practice:listScores',
  'speech:saveFromNode',
  'speech:saveFromQuiz',
  'speech:list',
  'speech:listForSource',
  'speech:update',
  'speech:delete',
  'speech:export',
  'annotation:list',
  'annotation:listForCampaign',
  'annotation:create',
  'annotation:delete',
  'annotation:toggleBookmark',
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
  'evidence:extract',
  'evidence:listConfirmed',
  'evidence:listProposed',
  'evidence:propose',
  'evidence:confirm',
  'evidence:reject',
  'story:list',
  'story:get',
  'story:create',
  'story:revise',
  'story:delete',
  'story:createDelivery',
  'story:listDeliveries',
] as const satisfies readonly IpcInvokeChannel[];

export const IPC_EVENT_CHANNELS = [
  'window:state',
  'stream:delta',
  'stream:tool',
  'stream:done',
  'stream:error',
  'job:progress',
  'campaign:attached',
  'campaign:capability-changed',
  'practice:completed',
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
