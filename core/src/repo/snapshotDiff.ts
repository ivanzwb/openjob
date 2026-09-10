/**
 * 重新索引时，算出 repo_file 快照该改哪几行。
 *
 * 不能删光重插：repo_file 是跨设备同步的，删 N 条再插 N 条会在 oplog 里留下
 * 2N 条变更，手机端于是要把整个几十 MB 的源码快照重新拉一遍——而它本来就有
 * 「磁盘不够就跳过 repo_file」的保护，一更新仓库就容易踩到那条路。只动真正
 * 变了的文件，同步的代价才和这次改动的大小成正比。
 */

import { normalizeRepoPath } from './virtualFs';

export interface SnapshotPlan {
  /** 新增的文件路径 */
  insertPaths: string[];
  /** 内容变了的文件路径 */
  updatePaths: string[];
  /** 上游已删除的行 id */
  deleteIds: string[];
  /** 内容没变、这次一个字都不用碰的文件数 */
  unchanged: number;
}

export function planSnapshotDiff(
  existing: Iterable<{ id: string; path: string; hash: string }>,
  incoming: Iterable<{ path: string; hash: string }>,
): SnapshotPlan {
  const old = new Map<string, { id: string; hash: string }>();
  for (const row of existing) {
    old.set(normalizeRepoPath(row.path), { id: row.id, hash: row.hash });
  }

  const insertPaths: string[] = [];
  const updatePaths: string[] = [];
  const seen = new Set<string>();
  let unchanged = 0;

  for (const file of incoming) {
    const path = normalizeRepoPath(file.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const prev = old.get(path);
    if (!prev) insertPaths.push(path);
    else if (prev.hash !== file.hash) updatePaths.push(path);
    else unchanged++;
  }

  const deleteIds: string[] = [];
  for (const [path, prev] of old) {
    if (!seen.has(path)) deleteIds.push(prev.id);
  }

  return { insertPaths, updatePaths, deleteIds, unchanged };
}
