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
   * null 表示整行都算新内容——新增行，或全表快照里无从得知改了哪几列的行。
   */
  changedFields: string[] | null;
  /**
   * 这一行最后一次更新的时间，取自发送方的 sync_row_version。
   * 接收方会用握手测得的时钟偏移校正后再比较。
   */
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

/**
 * 一处已经按「后写覆盖」自动裁决掉的分歧，仅供事后追溯。
 *
 * 合并不会因为它停下来等用户，但被丢掉的值必须留痕：自动覆盖是同步链路上
 * 唯一会丢用户输入的地方。
 */
export interface FieldOverwrite {
  table: string;
  rowId: string;
  /** 'delete' 是行级分歧的特殊字段名：一端删了、另一端改了 */
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  /** 两个时间都已归一到本机时钟，可直接比较 */
  localWallMs: number;
  remoteWallMs: number;
  /** 时间较晚、最终生效的那一边 */
  keptSide: 'local' | 'remote';
  /** 给用户看的行标题，例如「知识点：TCP 三次握手」 */
  label: string;
}

/** 一处待落库的变更 */
export interface AutoChange {
  table: string;
  rowId: string;
  kind: 'insert' | 'patch' | 'delete';
  /** patch 时只包含要覆盖的列 */
  values: Record<string, unknown>;
  /**
   * 这份数据在来源端的更新时间（已归一到本机时钟）。
   * 落库时写进 sync_row_version，不能用本机当前时间——否则本机副本会因为
   * 「刚写入」而显得比来源更新，下一轮又被推回去，两端反复互相覆盖。
   */
  wallMs: number;
}

export interface MergePlan {
  auto: AutoChange[];
  /** 自动覆盖的留痕，不阻塞落库 */
  overwrites: FieldOverwrite[];
}

export interface SyncRunSummary {
  id: string;
  peerDeviceId: string;
  peerName: string;
  direction: 'auto' | 'manual';
  status: 'running' | 'success' | 'failed' | 'rolledBack';
  appliedCount: number;
  overwriteCount: number;
  backupFile: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
}

// ---------------------------------------------------------------------------
// 整库快照
// ---------------------------------------------------------------------------

/**
 * 快照为什么被创建出来。写进文件名，所以只能是 [a-zA-Z0-9_]。
 *
 * 保留策略按 reason 分组，不是简单的「留最近 N 份」：手机端只留 3 份，
 * 升级前那份要是被之后几次同步前快照挤掉，「升级不该丢数据」就成了空话。
 */
export type BackupReason = 'presync' | 'premigrate' | 'prerestore' | 'manual';

export const BACKUP_REASON_LABEL: Record<BackupReason, string> = {
  presync: '同步前',
  premigrate: '升级前',
  prerestore: '回退前',
  manual: '手动',
};

/** 两端的快照目录各自独立，互不知情，但对外的形状一致 */
export interface BackupInfo {
  /** 文件名，不含目录 */
  file: string;
  sizeBytes: number;
  createdAt: number;
  reason: string;
}

export function backupReasonLabel(reason: string): string {
  return BACKUP_REASON_LABEL[reason as BackupReason] ?? reason;
}

export interface BackupRetention {
  /** 同步前快照无条件保留最近这几份 */
  recentPresync: number;
  /** 再按天各保留一份最新的同步前快照，往回保留这么多天 */
  presyncDays: number;
  /** 同步前之外，每一类各留几份 */
  other: number;
  /**
   * 所有快照加起来的字节上限。
   *
   * 只封份数封不住体积：快照是整库拷贝，而库里有 repo_file 源码快照，一份可能
   * 几百 MB，乘上二十几份就是几个 GB。份数上限只保证「有多少份」，这条才保证
   * 「占多少地方」。
   */
  maxTotalBytes: number;
}

/** 同步前快照的最小间隔：比这更密的两次同步共用上一份 */
export const PRESYNC_BACKUP_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * 这次同步要不要新留一份快照。
 *
 * 同步每 60 秒一轮，每轮都留一份的话，"留最近 10 份"只能覆盖十分钟——
 * 等用户发现数据不对，能救命的那一份早被后面的快照挤掉了。这个节流让配额
 * 换成时间跨度：代价是回退最多多丢 15 分钟的改动，而那些改动多半还在对端。
 */
export function shouldCreatePresyncBackup(
  lastPresyncAt: number | null,
  now: number,
  minIntervalMs = PRESYNC_BACKUP_MIN_INTERVAL_MS,
): boolean {
  if (lastPresyncAt === null) return true;
  return now - lastPresyncAt >= minIntervalMs;
}

/** 把毫秒时间戳归到本地日期（YYYY-MM-DD），按天保留时用它分桶 */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 挑出该删的快照。
 *
 * 三条规则叠加，都不是简单的「全局留最近 N 份」：
 *
 * 1. 按 reason 分组。同步前快照产生得最勤，全局排序会让它很快把「升级前」
 *    那一份挤出去，而「升级不该丢数据」全靠那一份兜底。
 * 2. 同步前快照分两层：最近几份无条件留（刚出问题时要能退到几分钟前），
 *    再按天各留一份（几天后才发现问题时也还有东西可退）。只按份数留的话
 *    可恢复的时间跨度会被同步频率决定，那不是一个能用的恢复方案。
 * 3. 总字节数封顶，超了从旧到新淘汰。份数上限管不住磁盘：一份快照的大小
 *    等于整个库，库里的 repo_file 源码快照能到几百 MB。
 *
 * 保留策略两端共用，实际删文件的动作各自用自己的文件 API 做。
 */
export function selectStaleBackups(all: BackupInfo[], retention: BackupRetention): BackupInfo[] {
  const newestFirst = [...all].sort((a, b) => b.createdAt - a.createdAt);
  const keptByReason = new Map<string, number>();
  const keptDays = new Set<string>();
  const kept: BackupInfo[] = [];
  const stale: BackupInfo[] = [];

  for (const backup of newestFirst) {
    if (backup.reason !== 'presync') {
      const count = keptByReason.get(backup.reason) ?? 0;
      if (count < retention.other) {
        keptByReason.set(backup.reason, count + 1);
        kept.push(backup);
      } else {
        stale.push(backup);
      }
      continue;
    }

    const recent = keptByReason.get('presync') ?? 0;
    if (recent < retention.recentPresync) {
      keptByReason.set('presync', recent + 1);
      keptDays.add(dayKey(backup.createdAt));
      kept.push(backup);
      continue;
    }

    // 每天留一份最新的，且只往回留 presyncDays 天
    const day = dayKey(backup.createdAt);
    if (!keptDays.has(day) && keptDays.size < retention.presyncDays) {
      keptDays.add(day);
      kept.push(backup);
      continue;
    }
    stale.push(backup);
  }

  stale.push(...selectOverBudget(kept, retention.maxTotalBytes));
  return stale;
}

/**
 * 总量超标时再淘汰一批，从旧到新。
 *
 * 每一类最新的那一份不参与淘汰：它们各自是一条退路的终点（最新的同步前 =
 * 撤销刚才那次同步，最新的升级前 = 回到升级之前），删掉就等于这条退路没了。
 * 所以这个上限是尽力而为——库本身大到几份就超标时，保底的退路优先于上限。
 */
function selectOverBudget(kept: BackupInfo[], maxTotalBytes: number): BackupInfo[] {
  if (maxTotalBytes <= 0) return [];

  let total = kept.reduce((sum, b) => sum + b.sizeBytes, 0);
  if (total <= maxTotalBytes) return [];

  // kept 是新→旧，每类第一次出现的就是该类最新的一份
  const seenReasons = new Set<string>();
  const protectedFiles = new Set<string>();
  for (const b of kept) {
    if (!seenReasons.has(b.reason)) {
      seenReasons.add(b.reason);
      protectedFiles.add(b.file);
    }
  }

  const evicted: BackupInfo[] = [];
  const oldestFirst = kept
    .filter((b) => !protectedFiles.has(b.file))
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const b of oldestFirst) {
    if (total <= maxTotalBytes) break;
    evicted.push(b);
    total -= b.sizeBytes;
  }
  return evicted;
}

// ---------------------------------------------------------------------------
// HTTP 协议（桌面端服务 / 手机端客户端共用）
// ---------------------------------------------------------------------------

/**
 * 每个请求都带上发起方的应用版本。
 *
 * 桌面端在动数据之前先比一次：版本不同就拒绝，返回 409 与
 * `code: 'versionMismatch'`。字段可缺省是为了给不带版本号的老手机端一个
 * 说得清的拒绝理由——认不出版本同样不放行，但错误文案要能告诉用户去升级。
 */
export interface SyncVersionedRequest {
  appVersion?: string;
}

export interface SyncPingRequest extends SyncVersionedRequest {
  clientMs: number;
}

export interface SyncPingResponse {
  serverMs: number;
  deviceId: string;
  displayName: string;
  appVersion: string;
}

export interface SyncPairRequest extends SyncVersionedRequest {
  code: string;
  deviceId: string;
  displayName: string;
  platform: string;
}

export interface SyncPairResponse {
  sharedKey: string;
  deviceId: string;
  displayName: string;
  appVersion: string;
}

export interface SyncExchangeRequest extends SyncVersionedRequest {
  sinceSeq: number;
  changes: ChangeSet;
  clientMs: number;
  /**
   * 为 true 时对端返回全表快照而非 oplog 增量。
   * 由发起方自动判定（首次配对、切换对端、上次同步失败、或距上次全表对账
   * 太久），不由用户选择。
   */
  full?: boolean;
}

export interface SyncExchangeResponse {
  changes: ChangeSet;
  appliedCount: number;
  /** 对端侧发生的自动覆盖数量 */
  overwriteCount: number;
  /** 对端侧因引用不存在的父行而被跳过的变更数（父行已删除或从未存在） */
  skippedCount?: number;
  runId: string;
  serverMs: number;
  appVersion: string;
}

export interface SyncRpcRequest extends SyncVersionedRequest {
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
