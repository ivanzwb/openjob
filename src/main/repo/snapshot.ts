import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  isTextFileName,
  joinRepoPath,
  normalizeRepoPath,
} from '@shared/repo/virtualFs';
import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_TOTAL_BYTES,
  SKIP_DIRS,
} from '@shared/repo/constants';
import { planSnapshotDiff } from '@shared/repo/snapshotDiff';
import { getDb, schema } from '../db';

export interface SnapshotResult {
  /** 快照里现有的文件总数 */
  files: number;
  /** 快照总字节数 */
  bytes: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

interface ScannedFile {
  path: string;
  content: string;
  byteSize: number;
  lineCount: number;
  hash: string;
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** 走一遍磁盘，收集该进快照的文本文件（受条数与总体积上限约束） */
function scanTextFiles(repoRoot: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  let bytes = 0;

  const walk = (dir: string, relBase: string): void => {
    if (out.length >= MAX_SNAPSHOT_FILES || bytes >= MAX_SNAPSHOT_TOTAL_BYTES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_SNAPSHOT_FILES || bytes >= MAX_SNAPSHOT_TOTAL_BYTES) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = normalizeRepoPath(joinRepoPath(relBase, e.name));
      if (e.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!isTextFileName(e.name)) continue;
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES || size === 0) continue;
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const byteSize = Buffer.byteLength(content, 'utf8');
      if (bytes + byteSize > MAX_SNAPSHOT_TOTAL_BYTES) return;

      out.push({
        path: rel,
        content,
        byteSize,
        lineCount: content.split(/\r?\n/).length,
        hash: hashContent(content),
      });
      bytes += byteSize;
    }
  };

  walk(repoRoot, '.');
  return out;
}

/**
 * 把文本文件快照进 repo_file，供手机端同步后读源码。
 *
 * 增量写：只动新增/改动/删除的文件。仓库更新后重新索引时，绝大多数文件其实
 * 没变，全量删插会让手机端把整份快照重新拉一遍（见 snapshotDiff 的注释）。
 *
 * 比较用的是内容哈希，而不是 mtime 或体积：git reset 会把所有检出的文件都盖上
 * 新的 mtime，而同长度的改动（改个数字、换个标识符）体积也一模一样。库里没存
 * 哈希列，所以旧内容得读出来现算——加一列要在两端各上一次 migration，而这份
 * 快照本来就有 30MB 上限，本地读一遍不值得为它动 schema。
 */
export function snapshotRepoFiles(repoId: string, repoRoot: string): SnapshotResult {
  const scanned = scanTextFiles(repoRoot);
  const db = getDb();

  const existingRows = db
    .select({
      id: schema.repoFile.id,
      filePath: schema.repoFile.filePath,
      content: schema.repoFile.content,
    })
    .from(schema.repoFile)
    .where(eq(schema.repoFile.repoId, repoId))
    .all();

  const idByPath = new Map<string, string>();
  for (const row of existingRows) idByPath.set(normalizeRepoPath(row.filePath), row.id);

  const plan = planSnapshotDiff(
    existingRows.map((r) => ({ id: r.id, path: r.filePath, hash: hashContent(r.content) })),
    scanned,
  );

  const byPath = new Map(scanned.map((f) => [f.path, f]));
  const now = Date.now();

  for (const id of plan.deleteIds) {
    db.delete(schema.repoFile).where(eq(schema.repoFile.id, id)).run();
  }

  // 改动的文件保留原行 id：同步端看到的是一条 update，而不是删一条再加一条
  for (const path of plan.updatePaths) {
    const file = byPath.get(path);
    const id = idByPath.get(path);
    if (!file || !id) continue;
    db.update(schema.repoFile)
      .set({
        content: file.content,
        lineCount: file.lineCount,
        byteSize: file.byteSize,
        updatedAt: now,
      })
      .where(eq(schema.repoFile.id, id))
      .run();
  }

  for (const path of plan.insertPaths) {
    const file = byPath.get(path);
    if (!file) continue;
    db.insert(schema.repoFile)
      .values({
        id: randomUUID(),
        repoId,
        filePath: file.path,
        content: file.content,
        lineCount: file.lineCount,
        byteSize: file.byteSize,
        updatedAt: now,
      })
      .run();
  }

  return {
    files: scanned.length,
    bytes: scanned.reduce((sum, f) => sum + f.byteSize, 0),
    added: plan.insertPaths.length,
    updated: plan.updatePaths.length,
    removed: plan.deleteIds.length,
    unchanged: plan.unchanged,
  };
}

/**
 * 快照里登记的文件路径，用来给读不到的路径找相近候选。
 * 注意快照有条数和体积上限，不在这份清单里不等于仓库里没有，所以只配拿来「建议」。
 */
export function listRepoFilePaths(repoId: string): string[] {
  return getDb()
    .select({ filePath: schema.repoFile.filePath })
    .from(schema.repoFile)
    .where(eq(schema.repoFile.repoId, repoId))
    .all()
    .map((r) => r.filePath);
}
