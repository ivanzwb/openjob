import { Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { AutoChange } from '@shared/sync';
import { partitionRepoFileChanges, REPO_FILE_TABLE } from './repoFilePartition';

export { partitionRepoFileChanges, REPO_FILE_TABLE };

/** 为系统与应用预留的可用空间，避免同步后磁盘写满 */
export const DISK_RESERVE_BYTES = 50 * 1024 * 1024;

function bytesFromContent(content: string): number {
  try {
    return new TextEncoder().encode(content).length;
  } catch {
    return content.length;
  }
}

function estimateChangeBytes(change: AutoChange, sqlite?: SQLiteDatabase): number {
  if (change.kind === 'delete') return 0;
  const { values } = change;
  if (typeof values.byte_size === 'number' && values.byte_size > 0) {
    return values.byte_size;
  }
  if (typeof values.content === 'string') {
    return bytesFromContent(values.content);
  }
  if (change.kind === 'patch' && sqlite && typeof values.byte_size === 'number') {
    const existing = sqlite.getFirstSync<{ byte_size: number }>(
      `SELECT byte_size FROM repo_file WHERE id = ?`,
      change.rowId,
    );
    if (existing) return Math.max(0, values.byte_size - existing.byte_size);
  }
  return 0;
}

/** 估算本轮 repo_file 变更所需额外存储（字节） */
export function estimateRepoFileBytes(changes: AutoChange[], sqlite?: SQLiteDatabase): number {
  let total = 0;
  for (const change of changes) {
    total += estimateChangeBytes(change, sqlite);
  }
  return total;
}

/** SDK 57 起可用空间是同步属性，老的 getFreeDiskStorageAsync 会在运行时直接抛错 */
export function getFreeDiskBytes(): number {
  return Paths.availableDiskSpace;
}

export function canApplyRepoFileSync(neededBytes: number, freeBytes: number): boolean {
  return freeBytes - DISK_RESERVE_BYTES >= neededBytes;
}

export function formatBytesForUser(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function buildRepoFileSkipMessage(neededBytes: number, freeBytes: number): string {
  const available = Math.max(0, freeBytes - DISK_RESERVE_BYTES);
  return (
    `存储空间不足，已跳过代码库文件同步（约需 ${formatBytesForUser(neededBytes)}，` +
    `可用 ${formatBytesForUser(available)}，已预留 ${formatBytesForUser(DISK_RESERVE_BYTES)} 给系统）`
  );
}
