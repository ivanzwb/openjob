/**
 * 仓库更新后把代码引用挪到新行号上。
 *
 * 单独一个模块是为了避开循环依赖：codeRefs.ts 要 import repository.ts，
 * 而这一遍是由 repository.ts 里的更新流程发起的。
 */

import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { reanchorSnippet } from '@shared/repo/reanchor';
import { getDb, schema } from '../db';
import { safeRepoPath } from './files';

export interface ReanchorSummary {
  /** 找到了，行号挪了 */
  moved: number;
  /** 找到了，位置没变 */
  verified: number;
  /** 找不着，保持旧 commit 的记录 */
  stale: number;
}

/**
 * 「失效」不用新加一列：定位成功的引用把 commit_sha 更新成新 sha，失败的保持旧值，
 * 于是 code_ref.commit_sha !== repo.commit_sha 就是失效标志——这正是这一列当初存在
 * 的意义（见 codeRefs.ts 里存 snippet 那段注释）。
 *
 * 定位不了的行一个字都不动：宁可留着旧行号、外加一个「来自旧版本」的事实，
 * 也不要把用户的标记搬到一段碰巧长得像的代码上去。
 */
export function reanchorRepoCodeRefs(
  repoId: string,
  repoRoot: string,
  commitSha: string | null,
): ReanchorSummary {
  const db = getDb();
  const refs = db
    .select()
    .from(schema.codeRef)
    .where(eq(schema.codeRef.repoId, repoId))
    .all()
    .filter((r) => r.commitSha !== commitSha);

  const summary: ReanchorSummary = { moved: 0, verified: 0, stale: 0 };
  // 同一个文件常挂着多条引用，内容按路径缓存读一次就够；null 表示读不到
  const contents = new Map<string, string | null>();

  for (const ref of refs) {
    if (!ref.snippet) {
      // grep 命中的引用没存片段，无从校验，只能算失效
      summary.stale++;
      continue;
    }

    if (!contents.has(ref.filePath)) {
      try {
        contents.set(ref.filePath, readFileSync(safeRepoPath(repoRoot, ref.filePath), 'utf8'));
      } catch {
        contents.set(ref.filePath, null);
      }
    }
    const content = contents.get(ref.filePath);
    if (!content) {
      summary.stale++;
      continue;
    }

    const found = reanchorSnippet(content, {
      snippet: ref.snippet,
      startLine: ref.startLine,
      endLine: ref.endLine,
    });
    if (!found) {
      summary.stale++;
      continue;
    }

    const unchanged = found.startLine === ref.startLine && found.endLine === ref.endLine;
    db.update(schema.codeRef)
      .set({ startLine: found.startLine, endLine: found.endLine, commitSha })
      .where(eq(schema.codeRef.id, ref.id))
      .run();
    if (unchanged) summary.verified++;
    else summary.moved++;
  }

  return summary;
}
