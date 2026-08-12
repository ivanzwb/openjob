import { randomUUID } from 'node:crypto';
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
import { getDb, schema } from '../db';

/** 索引完成后把文本文件快照进 repo_file，供手机端同步后读源码 */
export function snapshotRepoFiles(repoId: string, repoRoot: string): { files: number; bytes: number } {
  const db = getDb();
  db.delete(schema.repoFile).where(eq(schema.repoFile.repoId, repoId)).run();

  const now = Date.now();
  let files = 0;
  let bytes = 0;

  const walk = (dir: string, relBase: string): void => {
    if (files >= MAX_SNAPSHOT_FILES || bytes >= MAX_SNAPSHOT_TOTAL_BYTES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files >= MAX_SNAPSHOT_FILES || bytes >= MAX_SNAPSHOT_TOTAL_BYTES) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = normalizeRepoPath(joinRepoPath(relBase, e.name));
      if (e.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!isTextFileName(e.name)) continue;
      let size = 0;
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

      const lineCount = content.split(/\r?\n/).length;
      db.insert(schema.repoFile)
        .values({
          id: randomUUID(),
          repoId,
          filePath: rel,
          content,
          lineCount,
          byteSize,
          updatedAt: now,
        })
        .run();
      files++;
      bytes += byteSize;
    }
  };

  walk(repoRoot, '.');
  return { files, bytes };
}
