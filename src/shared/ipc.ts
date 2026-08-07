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
import type { EvidenceKind, LlmRole, SearchProviderName } from './enums';
import type { Citation } from './entities';

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
