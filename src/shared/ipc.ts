/**
 * IPC 契约：主进程与渲染进程之间的唯一通信面，替代 HTTP 路由。
 *
 * 两类通道：
 * - invoke: 请求/响应，对应 ipcMain.handle
 * - event:  主进程单向推送，用于流式输出与长任务进度
 *
 * 渲染进程只能通过 preload 暴露的白名单方法访问这里声明的通道。
 */

import type { AppConfig } from './config';
import type {
  EvidenceKind,
  LlmRole,
  NodeKind,
  SearchProviderName,
  CampaignStatus,
  CoverageType,
  NodeStatus,
  ExplanationTier,
  ReportSourceType,
  AnnotationTarget,
  AnnotationKind,
} from './enums';
import type {
  Campaign,
  Citation,
  CompanyIntel,
  Explanation,
  InterviewReport,
  KnowledgeNode,
  PlanDay,
  QuizAttempt,
  Repo,
  Resume,
  SpeechSnippet,
  Task,
  Annotation,
} from './entities';

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

export interface AppPaths {
  userData: string;
  dbFile: string;
  reposDir: string;
  cacheDir: string;
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
  /** 指定后启用代码 Agent 工具集（list_dir / read_file / grep） */
  repoId?: string;
  sessionId?: string;
}

export interface StreamStarted {
  streamId: string;
}

export interface StreamDelta {
  streamId: string;
  /** 增量文本 */
  delta: string;
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
  contentMd: string;
  citations: Citation[];
  /** 本次回答的主要信息来源类型，UI 用 SourceBadge 渲染 */
  evidenceKind: EvidenceKind;
  usage: { promptTokens: number; completionTokens: number } | null;
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
}

export interface SearchResultItem {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  contentMd: string | null;
  publishedAt: number | null;
  credibility: number;
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

export interface CreateCampaignInput {
  company: string;
  roleTitle: string;
  jdRaw: string;
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
}

// ---------------------------------------------------------------------------
// 计划与执行（阶段 2）
// ---------------------------------------------------------------------------

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

export interface ExplainGetInput {
  nodeId: string;
  tier: ExplanationTier;
}

export interface ExplainGenerateInput {
  nodeId: string;
  tier: ExplanationTier;
}

export interface QuizQuestionResult {
  nodeId: string;
  nodeName: string;
  question: string;
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

export interface RepoAddInput {
  url: string;
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
// 系统设计（阶段 5）
// ---------------------------------------------------------------------------

export interface DesignCaseResult {
  campaignId: string;
  company: string;
  roleTitle: string;
  title: string;
  scenarioMd: string;
  constraints: string[];
  evaluationCriteria: string[];
}

export interface DesignSubmitInput {
  campaignId: string;
  caseTitle: string;
  scenarioMd: string;
  userAnswer: string;
}

export interface DesignSubmitResult {
  score: number;
  feedbackMd: string;
  improvedOutlineMd: string;
  speechSnippetId: string;
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
}

export interface AnnotationToggleInput {
  targetType: AnnotationTarget;
  targetId: string;
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
// 通道映射
// ---------------------------------------------------------------------------

/** 请求/响应通道。新增能力时在此登记，两端自动获得类型约束。 */
export interface IpcInvokeMap {
  'app:getPaths': { req: void; res: AppPaths };
  'app:getVersion': { req: void; res: string };

  'config:get': { req: void; res: AppConfig };
  'config:update': { req: AppConfig; res: AppConfig };
  /** 密钥单独走 safeStorage，不进 config.json */
  'config:setSecret': { req: { ref: string; value: string }; res: void };
  'config:hasSecret': { req: { ref: string }; res: boolean };
  'config:deleteSecret': { req: { ref: string }; res: void };

  'llm:testRole': { req: { role: LlmRole }; res: ProviderTestResult };
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
  'resume:create': { req: CreateResumeInput; res: Resume };
  'resume:delete': { req: { id: string }; res: void };

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

  'node:update': { req: UpdateNodeInput; res: KnowledgeNode };
  'node:delete': { req: { id: string }; res: void };
  'node:create': { req: CreateNodeInput; res: KnowledgeNode };

  'plan:generate': { req: PlanGenerateInput; res: PlanGenerateResult };
  'plan:getToday': { req: { campaignId?: string }; res: TodayPlan | null };
  'plan:deferToday': { req: { campaignId: string }; res: { deferred: number } };

  'task:complete': { req: { taskId: string; actualMinutes?: number }; res: TaskView };
  'task:skip': { req: { taskId: string }; res: TaskView };

  'explain:get': { req: ExplainGetInput; res: Explanation | null };
  'explain:generate': { req: ExplainGenerateInput; res: Explanation };
  'explain:fallback': { req: { nodeId: string }; res: Explanation };

  'quiz:question': { req: { nodeId: string }; res: QuizQuestionResult };
  'quiz:submit': { req: QuizSubmitInput; res: QuizSubmitResult };

  'repo:list': { req: void; res: Repo[] };
  'repo:get': { req: { id: string }; res: Repo };
  'repo:add': { req: RepoAddInput; res: DiagnosisJobStarted };
  'repo:delete': { req: { id: string }; res: void };
  'repo:readFile': { req: RepoReadFileInput; res: RepoReadFileResult };
  'speech:save': { req: SpeechSaveInput; res: SpeechSnippet };
  'speech:saveFromNode': { req: SpeechSaveFromNodeInput; res: SpeechSnippet };
  'speech:list': { req: void; res: SpeechSnippetView[] };
  'speech:update': { req: SpeechUpdateInput; res: SpeechSnippet };
  'speech:delete': { req: { id: string }; res: void };
  'speech:export': { req: SpeechExportInput; res: SpeechExportResult };

  'design:case': { req: { campaignId: string }; res: DesignCaseResult };
  'design:submit': { req: DesignSubmitInput; res: DesignSubmitResult };

  'annotation:list': { req: { targetType: AnnotationTarget; targetId: string }; res: Annotation[] };
  'annotation:listForCampaign': { req: { campaignId: string }; res: Annotation[] };
  'annotation:create': { req: AnnotationCreateInput; res: Annotation };
  'annotation:delete': { req: { id: string }; res: void };
  'annotation:toggleBookmark': { req: AnnotationToggleInput; res: { bookmarked: boolean } };
}

/** 主进程 → 渲染进程的单向推送 */
export interface IpcEventMap {
  'stream:delta': StreamDelta;
  'stream:tool': StreamToolCall;
  'stream:done': StreamDone;
  'stream:error': StreamError;
  'job:progress': JobProgress;
}

export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcEventChannel = keyof IpcEventMap;

export type IpcReq<C extends IpcInvokeChannel> = IpcInvokeMap[C]['req'];
export type IpcRes<C extends IpcInvokeChannel> = IpcInvokeMap[C]['res'];

/** 供 preload 做白名单校验，避免渲染进程调用未登记的通道 */
export const IPC_INVOKE_CHANNELS = [
  'app:getPaths',
  'app:getVersion',
  'config:get',
  'config:update',
  'config:setSecret',
  'config:hasSecret',
  'config:deleteSecret',
  'llm:testRole',
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
  'resume:delete',
  'diagnosis:fromJd',
  'diagnosis:attachResume',
  'diagnosis:expandNode',
  'diagnosis:fetchIntel',
  'diagnosis:ingestReport',
  'node:update',
  'node:delete',
  'node:create',
  'plan:generate',
  'plan:getToday',
  'plan:deferToday',
  'task:complete',
  'task:skip',
  'explain:get',
  'explain:generate',
  'explain:fallback',
  'quiz:question',
  'quiz:submit',
  'repo:list',
  'repo:get',
  'repo:add',
  'repo:delete',
  'repo:readFile',
  'speech:save',
  'speech:saveFromNode',
  'speech:list',
  'speech:update',
  'speech:delete',
  'speech:export',
  'design:case',
  'design:submit',
  'annotation:list',
  'annotation:listForCampaign',
  'annotation:create',
  'annotation:delete',
  'annotation:toggleBookmark',
] as const satisfies readonly IpcInvokeChannel[];

export const IPC_EVENT_CHANNELS = [
  'stream:delta',
  'stream:tool',
  'stream:done',
  'stream:error',
  'job:progress',
] as const satisfies readonly IpcEventChannel[];

/**
 * preload 注入到 window 上的桥接对象。
 * 渲染进程通过它调用主进程，不直接接触 ipcRenderer。
 */
export interface IpcBridge {
  invoke<C extends IpcInvokeChannel>(channel: C, payload: IpcReq<C>): Promise<IpcRes<C>>;
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void;
}
