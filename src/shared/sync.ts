/**
 * 端间同步的线上协议与合并语义。
 *
 * 这个文件两端共用：桌面端主进程和手机端都按同一套类型收发，
 * 任何一边改了形状另一边编译期就会红。
 */

export type SyncOp = 'insert' | 'update' | 'delete';

/** 一行的当前完整值。删除用 tombstone 表示，不出现在这里 */
export interface RowSnapshot {
  table: string;
  rowId: string;
  /** 列名 → 值，取自发送方业务表的当前状态 */
  values: Record<string, unknown>;
  /**
   * 自上次同步以来实际变化过的列。
   * null 表示这是一次新增，整行都算新内容。
   */
  changedFields: string[] | null;
  /** 发送方本地墙钟毫秒，接收方会用握手测得的偏移校正 */
  wallMs: number;
}

export interface Tombstone {
  table: string;
  rowId: string;
  wallMs: number;
}

/** 一端自水位线以来的全部变更 */
export interface ChangeSet {
  deviceId: string;
  /** 发送方 oplog 推进到的位置，对端下次带回来作为水位线 */
  headSeq: number;
  rows: RowSnapshot[];
  tombstones: Tombstone[];
}

/** 需要用户裁决的一处分歧 */
export interface FieldConflict {
  table: string;
  rowId: string;
  /** 'delete' 是行级冲突的特殊字段名：一端删了、另一端改了 */
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  localWallMs: number;
  remoteWallMs: number;
  /** 给用户看的行标题，例如「知识点：TCP 三次握手」 */
  label: string;
}

/** 可以直接落库、不需要打扰用户的变更 */
export interface AutoChange {
  table: string;
  rowId: string;
  kind: 'insert' | 'patch' | 'delete';
  /** patch 时只包含要覆盖的列 */
  values: Record<string, unknown>;
}

export interface MergePlan {
  auto: AutoChange[];
  conflicts: FieldConflict[];
}

export type ConflictChoice = 'local' | 'remote';

export interface SyncRunSummary {
  id: string;
  peerDeviceId: string;
  peerName: string;
  direction: 'auto' | 'manual';
  status: 'running' | 'success' | 'conflict' | 'failed' | 'rolledBack';
  appliedCount: number;
  conflictCount: number;
  backupFile: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
}

// ---------------------------------------------------------------------------
// HTTP 协议（桌面端服务 / 手机端客户端共用）
// ---------------------------------------------------------------------------

export interface SyncPingRequest {
  clientMs: number;
}

export interface SyncPingResponse {
  serverMs: number;
  deviceId: string;
  displayName: string;
}

export interface SyncPairRequest {
  code: string;
  deviceId: string;
  displayName: string;
  platform: string;
}

export interface SyncPairResponse {
  sharedKey: string;
  deviceId: string;
  displayName: string;
}

export interface SyncExchangeRequest {
  sinceSeq: number;
  changes: ChangeSet;
  clientMs: number;
}

export interface SyncExchangeResponse {
  changes: ChangeSet;
  appliedCount: number;
  conflictCount: number;
  runId: string;
  status: 'success' | 'conflict';
  serverMs: number;
}

export interface SyncRpcRequest {
  channel: string;
  payload?: unknown;
}

export interface SyncRpcResponse {
  result: unknown;
  /** llm:chat 或长任务附带的推送事件 */
  events?: Array<{ channel: string; payload: unknown }>;
}

export interface SyncStatus {
  running: boolean;
  port: number | null;
  host: string;
  pairingActive: boolean;
  peers: Array<{
    deviceId: string;
    displayName: string;
    platform: string;
    lastSyncAt: number | null;
  }>;
}

/** 二维码内容：手机扫码后直连桌面端 */
export interface PairingPayload {
  v: 1;
  host: string;
  port: number;
  code: string;
  deviceId: string;
  displayName: string;
}
