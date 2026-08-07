import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { EnsureCodeRefInput } from '@shared/ipc';
import { getDb, schema } from '../db';
import { getRepo, readRepoFile } from './repository';

/**
 * 取得（必要时创建）一个代码位置记录。
 *
 * 标记代码位置需要一个稳定的 id，同一段位置被反复标记时必须复用同一行，
 * 否则收藏和笔记会散落在多个重复的 code_ref 上。
 */
export function ensureCodeRef(input: EnsureCodeRefInput): string {
  const db = getDb();
  const endLine = input.endLine ?? input.startLine;

  const existing = db
    .select({ id: schema.codeRef.id })
    .from(schema.codeRef)
    .where(
      and(
        eq(schema.codeRef.repoId, input.repoId),
        eq(schema.codeRef.filePath, input.filePath),
        eq(schema.codeRef.startLine, input.startLine),
        eq(schema.codeRef.endLine, endLine),
      ),
    )
    .get();
  if (existing) return existing.id;

  // 存快照：仓库更新后行号会漂移，留一份当时的内容才知道当初标的是什么
  let snippet: string | null = null;
  try {
    snippet = readRepoFile(input.repoId, input.filePath, input.startLine, endLine).content.slice(
      0,
      4000,
    );
  } catch {
    // 文件读不到不影响标记本身
  }

  let commitSha: string | null;
  try {
    commitSha = getRepo(input.repoId).commitSha;
  } catch {
    commitSha = null;
  }

  const id = randomUUID();
  db.insert(schema.codeRef)
    .values({
      id,
      repoId: input.repoId,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine,
      commitSha,
      snippet,
    })
    .run();
  return id;
}
