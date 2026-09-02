import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import simpleGit from 'simple-git';
import type { Repo } from '@shared/entities';
import type { RepoDeleteResult } from '@shared/ipc';
import { getDb, schema } from '../db';
import { getAppPaths } from '../paths';
import { completeJson } from '../llm/json';
import { formatPathSuggestions, suggestRepoPaths } from '@shared/repo/pathSuggest';
import { normalizeRepoPath } from '@shared/repo/virtualFs';
import { detectLanguages, readFileRange } from './files';
import { removeDirTree } from './removeDir';
import { buildRepoMapAsync } from './symbols';
import { reanchorRepoCodeRefs } from './reanchorRefs';
import { listRepoFilePaths, snapshotRepoFiles } from './snapshot';
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
  const root = getRepoLocalPath(repoId);
  try {
    return readFileRange(root, filePath, startLine, endLine);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // 回答里的 path:line 是正则从文本里扫出来的，模型编的路径同样会变成可点链接。
    // 原样抛 ENOENT 会把本机绝对路径显示到界面上——对用户毫无意义，还不如告诉他
    // 这个文件压根不存在，以及仓库里像它的是哪几个。
    const suggestions = suggestRepoPaths(listRepoFilePaths(repoId), filePath);
    // IPC 只把 message 送到界面，原始 ENOENT 挂在 cause 上留给主进程日志
    throw new Error(
      `仓库里没有这个文件：${normalizeRepoPath(filePath)}${formatPathSuggestions(suggestions)}`,
      { cause: err },
    );
  }
}

export interface CodeRefInput {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet?: string | null;
}

/**
 * Agent 读过/搜到的代码位置落库，供话术引用与后续跳转。
 * 同一段位置重复出现时只更新片段，不重复插入。
 */
export function recordCodeRefs(repoId: string, refs: CodeRefInput[]): void {
  if (refs.length === 0) return;
  const db = getDb();
  const existing = db
    .select()
    .from(schema.codeRef)
    .where(eq(schema.codeRef.repoId, repoId))
    .all();
  const seen = new Map(
    existing.map((r) => [`${r.filePath}:${r.startLine}-${r.endLine}`, r.id]),
  );
  const commitSha =
    db.select().from(schema.repo).where(eq(schema.repo.id, repoId)).get()?.commitSha ?? null;

  for (const ref of refs) {
    const key = `${ref.filePath}:${ref.startLine}-${ref.endLine}`;
    const snippet = ref.snippet ? ref.snippet.slice(0, 4000) : null;
    const hit = seen.get(key);
    if (hit) {
      if (snippet) {
        db.update(schema.codeRef).set({ snippet }).where(eq(schema.codeRef.id, hit)).run();
      }
      continue;
    }
    const id = randomUUID();
    db.insert(schema.codeRef)
      .values({
        id,
        repoId,
        filePath: ref.filePath,
        startLine: ref.startLine,
        endLine: ref.endLine,
        commitSha,
        snippet,
      })
      .run();
    seen.set(key, id);
  }
}

export function listCodeRefs(repoId: string): Array<{
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string | null;
}> {
  return getDb()
    .select()
    .from(schema.codeRef)
    .where(eq(schema.codeRef.repoId, repoId))
    .all()
    .map((r) => ({
      id: r.id,
      filePath: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      snippet: r.snippet,
    }));
}

export async function cloneAndIndex(url: string, jobId: string): Promise<void> {
  const label = '克隆并索引仓库';
  const report = (msg: string, progress: number | null): void => {
    emit('job:progress', { jobId, label, progress, message: msg, done: false, error: null });
  };
  // 只在行已经插进去之后才有值：clone 阶段就失败的话没有行可标记
  let repoId: string | null = null;

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
    repoId = id;

    report('正在生成 repo map…', 0.4);
    const repoMapMd = await buildRepoMapAsync(localPath);
    const languages = detectLanguages(localPath);

    report('正在生成项目摘要…', 0.7);
    const summary = await completeJson<{ summaryMd: string }>(
      'codeAgent',
      'repo.summary',
      `仓库 URL：${url}\n语言：${languages.join(', ')}\n\nRepo Map：\n${repoMapMd.slice(0, 12000)}`,
    );

    const now = Date.now();
    const snap = snapshotRepoFiles(id, localPath);
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
      message: `仓库已就绪（已同步 ${snap.files} 个文件到手机可读缓存）`,
      done: true,
      error: null,
    });
  } catch (err) {
    // 状态得落到 failed：否则失败的仓库会永远停在「索引中」，
    // 既不能问答（问答要求 status === 'ready'），列表上也看不出它已经死了。
    if (repoId) {
      try {
        getDb()
          .update(schema.repo)
          .set({ status: 'failed' })
          .where(eq(schema.repo.id, repoId))
          .run();
      } catch (dbErr) {
        console.error('[repo:add] 回写 failed 状态失败', dbErr);
      }
    }
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

/**
 * 把已有 clone 拉到上游最新，然后重建索引。
 *
 * 先比 commit sha 再决定要不要重建：git 的 commit 哈希就是整棵树的 Merkle 根，
 * 上游没动的话它一个字节都不会变。Cursor 那套要自己维护 Merkle 树，是因为它盯
 * 的是用户随时在改的工作区；这里的 clone 只有本函数会动，根哈希 git 白送。
 * 所以「仓库有没有变」是一次字符串比较，不用扫文件、不用存哈希树。
 *
 * 符号索引不在这里重建，因为它不存盘：find_symbol / glob / grep 都是查询时现扫
 * 磁盘，reset 完就自动是新代码了。要重建的只有那些真的存了盘的东西——repo map、
 * 语言、以及手机端要同步的 repo_file 快照。
 */
export async function updateRepoToLatest(repoId: string, jobId: string): Promise<void> {
  const label = '更新仓库';
  const report = (msg: string, progress: number | null): void => {
    emit('job:progress', { jobId, label, progress, message: msg, done: false, error: null });
  };
  const finish = (message: string): void => {
    emit('job:progress', { jobId, label, progress: 1, message, done: true, error: null });
  };

  const db = getDb();
  const row = db.select().from(schema.repo).where(eq(schema.repo.id, repoId)).get();

  try {
    assertGitAvailable();
    if (!row) throw new Error('仓库不存在');
    if (!existsSync(row.localPath)) {
      throw new Error(`本地 clone 已不在（${row.localPath}），请删除该仓库后重新添加。`);
    }

    // 重建期间标成 indexing：问答只在 ready 时放行，
    // 免得 agent 在 repo map 和文件快照对不上的中间态里读到半新半旧的代码。
    db.update(schema.repo).set({ status: 'indexing' }).where(eq(schema.repo.id, repoId)).run();

    const git = simpleGit({ baseDir: row.localPath, binary: resolveGitBinary() });
    const branch = (await git.branch()).current || row.defaultBranch;
    if (!branch) throw new Error('无法确定当前分支，请删除该仓库后重新添加。');

    report(`正在拉取 origin/${branch}…`, 0.15);
    // clone 时用了 --depth 1，fetch 也得带上，否则会把整部历史拉下来。
    // reset --hard 而不是 pull：这份 clone 是只读缓存，没有本地提交要保，
    // 直接对齐上游最省事，也不会因为 rebase/merge 冲突卡住。
    try {
      await git.raw(['fetch', '--depth', '1', 'origin', branch]);
    } catch (err) {
      // 上游把默认分支改名（master→main）或删了分支时，git 只回一句
      // couldn't find remote ref，用户根本不知道该怎么办
      throw new Error(
        `拉取 origin/${branch} 失败。若上游改了默认分支名或删除了该分支，` +
          `请删除该仓库后重新添加。原始错误：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    await git.raw(['reset', '--hard', 'FETCH_HEAD']);

    const commitSha = (await git.log({ maxCount: 1 })).latest?.hash ?? null;
    if (commitSha && commitSha === row.commitSha) {
      db.update(schema.repo).set({ status: 'ready' }).where(eq(schema.repo.id, repoId)).run();
      finish(`已是最新（${commitSha.slice(0, 7)}），无需重建索引`);
      return;
    }

    report('正在重建 repo map…', 0.4);
    const repoMapMd = await buildRepoMapAsync(row.localPath);
    const languages = detectLanguages(row.localPath);

    // 摘要是一次 LLM 调用。骨架没变就没必要重新花钱花时间——
    // 只改了函数体的提交在 repo map 上看不出差别，摘要也不会有新内容。
    let summaryMd = row.summaryMd;
    if (repoMapMd !== row.repoMapMd || !summaryMd) {
      report('正在更新项目摘要…', 0.6);
      const summary = await completeJson<{ summaryMd: string }>(
        'codeAgent',
        'repo.summary',
        `仓库 URL：${row.url}\n语言：${languages.join(', ')}\n\nRepo Map：\n${repoMapMd.slice(0, 12000)}`,
      );
      summaryMd = summary.summaryMd;
    }

    report('正在更新文件快照…', 0.8);
    const snap = snapshotRepoFiles(repoId, row.localPath);

    report('正在校准已有的代码引用…', 0.92);
    const anchors = reanchorRepoCodeRefs(repoId, row.localPath, commitSha);

    db.update(schema.repo)
      .set({
        commitSha,
        defaultBranch: branch,
        repoMapMd,
        summaryMd,
        languages,
        indexedAt: Date.now(),
        status: 'ready',
      })
      .where(eq(schema.repo.id, repoId))
      .run();

    const changed = snap.added + snap.updated + snap.removed;
    const parts = [
      changed === 0
        ? '文件快照无变化'
        : `快照新增 ${snap.added}、改动 ${snap.updated}、删除 ${snap.removed} 个文件`,
    ];
    // 失效的必须报出来：那些标记还挂在旧行号上，用户得知道有几处要自己回去看
    if (anchors.moved > 0) parts.push(`${anchors.moved} 处代码引用已跟随改动`);
    if (anchors.stale > 0) parts.push(`${anchors.stale} 处引用失效（原代码已不在）`);
    finish(`已更新到 ${commitSha?.slice(0, 7) ?? '最新'}：${parts.join('，')}`);
  } catch (err) {
    // 拉取失败时旧 clone 还是完整可用的，状态要还回 ready，
    // 不能因为一次断网就把能用的仓库标成 failed、连问答都不让开。
    if (row) {
      try {
        db.update(schema.repo)
          .set({ status: row.status })
          .where(eq(schema.repo.id, repoId))
          .run();
      } catch (dbErr) {
        console.error('[repo:update] 回滚状态失败', dbErr);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    emit('job:progress', { jobId, label, progress: null, message, done: true, error: message });
  }
}

/**
 * 删仓库条目，顺带删本地 clone。
 *
 * 目录删不掉时不能连条目一起留下：抛在 db.delete 之前的话，这个仓库每次点删除
 * 都撞同一个错，用户再也没有办法把它从列表里清掉。所以宁可留个孤儿目录，
 * 把完整路径交回给调用方让用户手删。
 */
export function deleteRepo(id: string): RepoDeleteResult {
  const db = getDb();
  const row = db.select().from(schema.repo).where(eq(schema.repo.id, id)).get();
  if (!row) return { leftoverPath: null, reason: null };

  let leftover: RepoDeleteResult = { leftoverPath: null, reason: null };
  if (existsSync(row.localPath)) {
    try {
      removeDirTree(row.localPath);
    } catch (err) {
      // IPC 只搬 message，cause 上挂的 errno / syscall 只有主进程日志留得住
      console.error(`[repo:delete] 删除本地 clone 失败：${row.localPath}`, err);
      leftover = {
        leftoverPath: row.localPath,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  db.delete(schema.repo).where(eq(schema.repo.id, id)).run();
  return leftover;
}

export { rowToRepo };
