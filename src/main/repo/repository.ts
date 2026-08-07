import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import simpleGit from 'simple-git';
import type { Repo } from '@shared/entities';
import { getDb, schema } from '../db';
import { getAppPaths } from '../paths';
import { completeJson } from '../llm/json';
import { buildRepoMap, detectLanguages, readFileRange } from './files';
import { assertGitAvailable, resolveGitBinary } from './git';
import { emit } from '../ipc/bridge';

function rowToRepo(row: typeof schema.repo.$inferSelect): Repo {
  return {
    id: row.id,
    url: row.url,
    localPath: row.localPath,
    defaultBranch: row.defaultBranch,
    commitSha: row.commitSha,
    languages: row.languages,
    repoMapMd: row.repoMapMd,
    summaryMd: row.summaryMd,
    indexedAt: row.indexedAt,
    status: row.status,
  };
}

export function listRepos(): Repo[] {
  return getDb()
    .select()
    .from(schema.repo)
    .all()
    .map(rowToRepo);
}

export function getRepo(id: string): Repo {
  const row = getDb().select().from(schema.repo).where(eq(schema.repo.id, id)).get();
  if (!row) throw new Error('仓库不存在');
  return rowToRepo(row);
}

export function getRepoLocalPath(id: string): string {
  const repo = getRepo(id);
  if (!existsSync(repo.localPath)) {
    throw new Error('仓库本地目录不存在，请重新 clone');
  }
  return repo.localPath;
}

export function readRepoFile(
  repoId: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): ReturnType<typeof readFileRange> {
  return readFileRange(getRepoLocalPath(repoId), filePath, startLine, endLine);
}

export async function cloneAndIndex(url: string, jobId: string): Promise<void> {
  const label = 'Clone 仓库';
  const report = (msg: string, progress: number | null): void => {
    emit('job:progress', { jobId, label, progress, message: msg, done: false, error: null });
  };

  try {
    assertGitAvailable();
    const { reposDir } = getAppPaths();
    const id = randomUUID();
    const dirName = `${basename(url).replace(/\.git$/, '')}-${id.slice(0, 8)}`;
    const localPath = join(reposDir, dirName);

    report('正在 clone…', 0.1);
    const git = simpleGit({ baseDir: reposDir, binary: resolveGitBinary() });
    await git.clone(url, dirName, ['--depth', '1']);

    const repoGit = simpleGit(localPath);
    const branch = (await repoGit.branch()).current;
    const log = await repoGit.log({ maxCount: 1 });
    const commitSha = log.latest?.hash ?? null;

    const db = getDb();
    db.insert(schema.repo)
      .values({
        id,
        url,
        localPath,
        defaultBranch: branch,
        commitSha,
        languages: [],
        repoMapMd: null,
        summaryMd: null,
        indexedAt: null,
        status: 'indexing',
      })
      .run();

    report('正在生成 repo map…', 0.4);
    const repoMapMd = buildRepoMap(localPath);
    const languages = detectLanguages(localPath);

    report('正在生成项目摘要…', 0.7);
    const summary = await completeJson<{ summaryMd: string }>(
      'codeAgent',
      `你是资深工程师。根据 repo map 写项目摘要，markdown 格式，包含：
- 模块划分与目录职责
- 核心数据结构
- 启动/主流程
- 关键设计决策
输出 JSON：{ "summaryMd": "..." }`,
      `仓库 URL：${url}\n语言：${languages.join(', ')}\n\nRepo Map：\n${repoMapMd.slice(0, 12000)}`,
    );

    const now = Date.now();
    db.update(schema.repo)
      .set({
        repoMapMd,
        summaryMd: summary.summaryMd,
        languages,
        indexedAt: now,
        status: 'ready',
      })
      .where(eq(schema.repo.id, id))
      .run();

    emit('job:progress', {
      jobId,
      label,
      progress: 1,
      message: '仓库已就绪',
      done: true,
      error: null,
    });
  } catch (err) {
    emit('job:progress', {
      jobId,
      label,
      progress: null,
      message: err instanceof Error ? err.message : String(err),
      done: true,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function deleteRepo(id: string): void {
  const db = getDb();
  const row = db.select().from(schema.repo).where(eq(schema.repo.id, id)).get();
  if (!row) return;

  if (existsSync(row.localPath)) {
    rmSync(row.localPath, { recursive: true, force: true });
  }
  db.delete(schema.repo).where(eq(schema.repo.id, id)).run();
}

export { rowToRepo };
