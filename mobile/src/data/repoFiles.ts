import type { SQLiteDatabase } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

export interface RepoFileEntry {
  path: string;
  content: string;
  lineCount: number;
  byteSize: number;
}

export function countRepoFiles(db: SQLiteDatabase, repoId: string): number {
  const row = db.getFirstSync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM repo_file WHERE repo_id = ?`,
    repoId,
  );
  return row?.n ?? 0;
}

export function listRepoFilePaths(db: SQLiteDatabase, repoId: string): string[] {
  const rows = db.getAllSync<{ file_path: string }>(
    `SELECT file_path FROM repo_file WHERE repo_id = ? ORDER BY file_path`,
    repoId,
  );
  return rows.map((r) => r.file_path);
}

export function getRepoFileContent(
  db: SQLiteDatabase,
  repoId: string,
  filePath: string,
): string | null {
  const row = db.getFirstSync<{ content: string }>(
    `SELECT content FROM repo_file WHERE repo_id = ? AND file_path = ?`,
    repoId,
    filePath,
  );
  return row?.content ?? null;
}

export function loadRepoFiles(db: SQLiteDatabase, repoId: string): RepoFileEntry[] {
  const rows = db.getAllSync<{
    file_path: string;
    content: string;
    line_count: number;
    byte_size: number;
  }>(
    `SELECT file_path, content, line_count, byte_size FROM repo_file WHERE repo_id = ?`,
    repoId,
  );
  return rows.map((r) => ({
    path: r.file_path,
    content: r.content,
    lineCount: r.line_count,
    byteSize: r.byte_size,
  }));
}

interface CodeRefInput {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string | null;
}

/** Agent 读过的代码位置落库，与桌面端 recordCodeRefs 行为一致 */
export function recordCodeRefs(
  db: SQLiteDatabase,
  repoId: string,
  refs: CodeRefInput[],
): void {
  if (refs.length === 0) return;

  const existing = db.getAllSync<{
    id: string;
    file_path: string;
    start_line: number;
    end_line: number;
  }>(`SELECT id, file_path, start_line, end_line FROM code_ref WHERE repo_id = ?`, repoId);

  const seen = new Map(
    existing.map((r) => [`${r.file_path}:${r.start_line}-${r.end_line}`, r.id]),
  );
  const commitRow = db.getFirstSync<{ commit_sha: string | null }>(
    `SELECT commit_sha FROM repo WHERE id = ?`,
    repoId,
  );
  const commitSha = commitRow?.commit_sha ?? null;

  for (const ref of refs) {
    const key = `${ref.filePath}:${ref.startLine}-${ref.endLine}`;
    const snippet = ref.snippet ? ref.snippet.slice(0, 4000) : null;
    const hit = seen.get(key);
    if (hit) {
      if (snippet) {
        db.runSync(`UPDATE code_ref SET snippet = ? WHERE id = ?`, snippet, hit);
      }
      continue;
    }
    const id = Crypto.randomUUID();
    db.runSync(
      `INSERT INTO code_ref (id, repo_id, file_path, start_line, end_line, commit_sha, snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      repoId,
      ref.filePath,
      ref.startLine,
      ref.endLine,
      commitSha,
      snippet,
    );
    seen.set(key, id);
  }
}
