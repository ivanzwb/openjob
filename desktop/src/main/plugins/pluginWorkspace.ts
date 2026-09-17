/**
 * 代码插件的**工作区原语**宿主实现（分发计划 §11.2）。
 *
 * 包侧在沙箱里通过 `ctx.workspace` / `openjob.workspace` 编排，实现在这里、跑在主进程：
 * 每次调用先经权限网关校验 `filesystem:workspace`，再做被约束在**本包工作区目录**内的
 * 文件操作。工作区位置与 `ctx.storage` 同一套约定——`userData/plugin-workspace/<pluginId>/`，
 * 一个包一块，与主库物理隔离，pluginId 先进稳定 ID 规则再进文件名（防路径穿越）。
 *
 * 三条边界都写死在这里，不靠调用方自觉（这是这个原语的核心保障）：
 * 1. **路径越界即拒**：绝对路径、`..` 逸出、经符号链接逸出，以及任何解析后不落在本包
 *    工作区内的路径，一律拒绝；
 * 2. **上限即报错**：单次读 / 单次写 / glob 结果数 / grep 命中数都有上限，超限抛错而不是
 *    静默截断；
 * 3. **只做文本与字节**：不执行、不解压、不建符号链接（遍历时也不跟随符号链接）。
 *
 * 符号提取（`workspaceSymbols`）复用同一条路径约束，解析交给宿主侧常驻的 tree-sitter 引擎
 * （`src/main/symbols/treeSitter.ts`）——**包沙箱里不跑解析器**，包只拿解析结果，语法文件
 * 缺失或语言不支持时如实回空符号而不是报错。
 *
 * 远端拉取（`workspaceFetch`）是本层**唯一离开这台机器**的动作：只放行公开的 https 地址、
 * 固定 argv、不传凭据、不读用户 git 配置（实现在 `src/main/workspace/`），且要额外声明
 * `network:fetch`。除它之外，这一层只碰本包工作区目录。
 *
 * 这一层不 import `plugins/package/(contract|replay)`，也不含任何代码执行入口。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app } from 'electron';
import { isStablePluginId } from '@core/plugins/contracts';
import type {
  WorkspaceEntry,
  WorkspaceFetchResult,
  WorkspaceGrepMatch,
  WorkspaceSnapshot,
  WorkspaceSymbolsFile,
  WorkspaceSymbolsResult,
} from '@core/plugins/pluginRuntime/host';
import { runGit } from '../workspace/git';
import {
  FETCH_LIMITS,
  deriveDirName,
  runFetch,
  validateFetchUrl,
  type FetchErrorCode,
  type GitRunner,
} from '../workspace/gitFetch';
import { extractSymbolsAst, grammarForExt } from '../symbols/treeSitter';
import type { PluginPermissionGateway } from './permissionGateway';

/** 原语上限。超限一律抛错，绝不静默截断——静默截断会让包侧拿到「看起来完整」的错结果。 */
export const WORKSPACE_LIMITS = {
  /** 单次读（含文本快照）的字节上限 */
  readBytes: 256 * 1024,
  /** 单次写的字节上限 */
  writeBytes: 256 * 1024,
  /** 单次 glob 的结果数上限 */
  globResults: 200,
  /** 单次 grep 的命中数上限 */
  grepMatches: 200,
  /** 单次列目录的条目数上限 */
  listEntries: 1000,
} as const;

/**
 * 符号提取的限流。分两档，口径刻意不同：
 *
 * - **输入**超限（路径太多）直接抛错：这是调用方一次问得太多，说不出「算了先给你一半」；
 * - **预算**用完（总字节 / 时间 / 结果条数）返回已完成部分 + `truncated`：数据多大由不得
 *   包，硬抛错只会逼出「更小的魔法数字」，如实回报才能让包自己收窄范围重来。
 */
export const SYMBOLS_LIMITS = {
  /** 单次调用的文件数上限 */
  paths: 2000,
  /** 单文件解析字节上限；超过只回摘要与 skipped='too-large'，不回符号 */
  fileBytes: 256 * 1024,
  /** 单次调用累计读入字节上限 */
  totalBytes: 32 * 1024 * 1024,
  /** 单文件符号条数上限 */
  perFile: 200,
  /** 单次调用符号总条数上限 */
  results: 5000,
  /** 单次调用时间预算（毫秒）；解析是同步的，在文件之间检查 */
  budgetMs: 10_000,
} as const;

export type WorkspaceErrorCode =
  | 'invalid-input'
  | 'path-absolute'
  | 'path-escape'
  | 'path-symlink-escape'
  | 'not-found'
  | 'read-limit'
  | 'write-limit'
  | 'glob-limit'
  | 'grep-limit'
  | 'list-limit'
  | 'symbols-limit'
  | 'fetch-invalid-url'
  | 'fetch-dir-occupied'
  | 'fetch-origin-mismatch'
  | 'fetch-limit'
  | 'fetch-unavailable'
  | 'fetch-failed';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** 权限未声明 / 被拒时的错误；不带出任何调用方给的路径。 */
export class WorkspaceAccessDeniedError extends Error {
  constructor(readonly reason: string) {
    super(`插件工作区访问被拒绝（${reason}）。`);
    this.name = 'WorkspaceAccessDeniedError';
  }
}

/** 本包工作区根：与 `ctx.storage` 同一套约定，一个包一块目录。 */
export function pluginWorkspaceRoot(pluginId: string): string {
  if (!isStablePluginId(pluginId)) {
    throw new WorkspaceError('invalid-input', `插件 id 不合法：${pluginId}`);
  }
  return join(app.getPath('userData'), 'plugin-workspace', pluginId);
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/** target 是否等于 root 或落在 root 之内（纯字符串判定，不含符号链接语义）。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 把一个相对路径解析进本包工作区；绝对路径与 `..` 逸出在这里挡住。 */
function resolveInRoot(root: string, input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new WorkspaceError('invalid-input', '工作区路径不能为空');
  }
  if (isAbsolute(input)) {
    throw new WorkspaceError('path-absolute', '工作区路径必须是相对本包目录的相对路径');
  }
  const target = resolve(root, input);
  if (!isInside(root, target)) {
    throw new WorkspaceError('path-escape', '工作区路径越出本包目录');
  }
  return target;
}

/**
 * 符号链接逸出：`..` 已在字符串层挡住，这一步专治「工作区内放一个指向外部的链接」。
 * 把目标（或它最近的已存在祖先）realpath 一把，真实位置必须仍在 realpath(root) 之内。
 */
function assertNoSymlinkEscape(root: string, target: string): void {
  const realRoot = realpathSync(root);
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = realpathSync(probe);
  if (!isInside(realRoot, real)) {
    throw new WorkspaceError('path-symlink-escape', '工作区路径经符号链接越出本包目录');
  }
}

function confine(root: string, input: unknown): string {
  const target = resolveInRoot(root, input);
  assertNoSymlinkEscape(root, target);
  return target;
}

/** 把 glob 模式编译成相对本包根的整串匹配正则；`**` 跨目录，`*` 不跨目录。 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** statSync 的容错版本：拿不到（不存在 / 没权限）返回 null，交给调用方决定。 */
function statFile(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** readdirSync 的容错版本；读不动当空目录，避免遍历路径上抛错。 */
function readDirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 递归列出工作区内全部文件的相对 POSIX 路径；不跟随符号链接。 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readDirSafe(dir)) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (entry.isFile()) out.push(toPosix(relative(root, abs)));
    }
  };
  visit(root);
  return out;
}

function sliceLines(
  text: string,
  options?: { startLine?: number; endLine?: number },
): string {
  const startRaw = options?.startLine;
  const endRaw = options?.endLine;
  const start = Math.max(1, Math.floor(startRaw ?? 1));
  const end = endRaw === undefined ? undefined : Math.max(start, Math.floor(endRaw));
  if (start === 1 && end === undefined) return text;
  return text.split('\n').slice(start - 1, end).join('\n');
}

export interface WorkspaceFileSystem {
  read(path: string, options?: { startLine?: number; endLine?: number }): string;
  write(path: string, content: string): void;
  delete(path: string): void;
  list(path?: string): WorkspaceEntry[];
  glob(pattern: string): string[];
  grep(pattern: string, options?: { path?: string }): WorkspaceGrepMatch[];
  snapshot(path: string): WorkspaceSnapshot | null;
}

/** 纯文件系统层：只认一个根目录，所有越界与上限判定都在这里。 */
export function createWorkspaceFileSystem(root: string): WorkspaceFileSystem {
  const realRoot = resolve(root);
  mkdirSync(realRoot, { recursive: true });

  return {
    read(path, options) {
      const target = confine(realRoot, path);
      const stats = existsSync(target) ? statSync(target) : null;
      if (!stats || !stats.isFile()) {
        throw new WorkspaceError('not-found', '工作区内不存在该文件');
      }
      if (stats.size > WORKSPACE_LIMITS.readBytes) {
        throw new WorkspaceError(
          'read-limit',
          `单次读超过 ${WORKSPACE_LIMITS.readBytes} 字节上限`,
        );
      }
      return sliceLines(readFileSync(target, 'utf8'), options);
    },

    write(path, content) {
      if (typeof content !== 'string') {
        throw new WorkspaceError('invalid-input', '写入内容必须是字符串');
      }
      if (Buffer.byteLength(content, 'utf8') > WORKSPACE_LIMITS.writeBytes) {
        throw new WorkspaceError(
          'write-limit',
          `单次写超过 ${WORKSPACE_LIMITS.writeBytes} 字节上限`,
        );
      }
      const target = confine(realRoot, path);
      if (target === realRoot) {
        throw new WorkspaceError('invalid-input', '不能用文件写入覆盖工作区根目录');
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },

    delete(path) {
      const target = confine(realRoot, path);
      if (target === realRoot) {
        throw new WorkspaceError('invalid-input', '不能删除工作区根目录');
      }
      if (!existsSync(target)) return;
      rmSync(target, { recursive: true, force: true });
    },

    list(path = '.') {
      const target = confine(realRoot, path);
      const stats = existsSync(target) ? statSync(target) : null;
      if (!stats || !stats.isDirectory()) {
        throw new WorkspaceError('not-found', '工作区内不存在该目录');
      }
      const entries = readdirSync(target, { withFileTypes: true });
      if (entries.length > WORKSPACE_LIMITS.listEntries) {
        throw new WorkspaceError(
          'list-limit',
          `目录条目超过 ${WORKSPACE_LIMITS.listEntries} 上限`,
        );
      }
      return entries
        .filter((entry) => !entry.isSymbolicLink())
        .map<WorkspaceEntry>((entry) => {
          const abs = join(target, entry.name);
          const isDir = entry.isDirectory();
          return {
            path: toPosix(relative(realRoot, abs)),
            type: isDir ? 'dir' : 'file',
            size: isDir ? null : statSync(abs).size,
          };
        })
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    },

    glob(pattern) {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new WorkspaceError('invalid-input', 'glob 模式不能为空');
      }
      // 只给文件名（不含 `/`）时在所有目录下找，与宿主既有 glob 口径一致
      const normalized = toPosix(pattern.includes('/') ? pattern : `**/${pattern}`);
      const matcher = globToRegExp(normalized);
      const results: string[] = [];
      for (const rel of walkFiles(realRoot)) {
        if (!matcher.test(rel)) continue;
        results.push(rel);
        if (results.length > WORKSPACE_LIMITS.globResults) {
          throw new WorkspaceError(
            'glob-limit',
            `glob 结果超过 ${WORKSPACE_LIMITS.globResults} 条上限`,
          );
        }
      }
      return results.sort();
    },

    grep(pattern, options) {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new WorkspaceError('invalid-input', 'grep 模式不能为空');
      }
      let matcher: RegExp;
      try {
        matcher = new RegExp(pattern);
      } catch {
        throw new WorkspaceError('invalid-input', 'grep 模式不是合法正则');
      }
      const scope = options?.path && options.path !== '.' ? options.path : '';
      const base = scope ? confine(realRoot, scope) : realRoot;
      const baseRel = toPosix(relative(realRoot, base));
      const matches: WorkspaceGrepMatch[] = [];
      for (const rel of walkFiles(realRoot)) {
        if (baseRel && rel !== baseRel && !rel.startsWith(`${baseRel}/`)) continue;
        const abs = join(realRoot, rel);
        const stats = statFile(abs);
        if (!stats) continue;
        // 超大文件不进 grep 范围：读进来只会触发 read 上限，不如直接跳过
        if (stats.size > WORKSPACE_LIMITS.readBytes) continue;
        const lines = readFileSync(abs, 'utf8').split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (!matcher.test(lines[index]!)) continue;
          matches.push({ path: rel, line: index + 1, text: lines[index]! });
          if (matches.length > WORKSPACE_LIMITS.grepMatches) {
            throw new WorkspaceError(
              'grep-limit',
              `grep 命中超过 ${WORKSPACE_LIMITS.grepMatches} 条上限`,
            );
          }
        }
      }
      return matches;
    },

    snapshot(path) {
      const target = confine(realRoot, path);
      const stats = existsSync(target) ? statSync(target) : null;
      if (!stats || !stats.isFile()) return null;
      if (stats.size > WORKSPACE_LIMITS.readBytes) {
        throw new WorkspaceError(
          'read-limit',
          `文本快照超过 ${WORKSPACE_LIMITS.readBytes} 字节上限`,
        );
      }
      const text = readFileSync(target, 'utf8');
      return {
        path: toPosix(relative(realRoot, target)),
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(text, 'utf8'),
        text,
      };
    },
  };
}

/** 服务层入参：网关每次调用都过一道；`root` 与 `gitRun` 是测试用的夹具覆盖。 */
export interface PluginWorkspaceAccess {
  permissionGateway: PluginPermissionGateway;
  /** Test seam；生产按 pluginId 解析到 userData 下的本包工作区 */
  root?: string;
  /** Test seam；生产用宿主侧收紧过的 git 管道（`src/main/workspace/git.ts`） */
  gitRun?: GitRunner;
}

/** 逐次校验权限，返回本包工作区根（已 resolve）。 */
function authorizedRoot(pluginId: string, access: PluginWorkspaceAccess): string {
  const decision = access.permissionGateway.authorizePlugin({
    pluginId,
    permission: 'filesystem:workspace',
  });
  if (!decision.allowed) throw new WorkspaceAccessDeniedError(decision.code);
  return resolve(access.root ?? pluginWorkspaceRoot(pluginId));
}

/** 逐次校验权限，然后返回绑定到本包工作区的文件系统。 */
function authorizedWorkspace(
  pluginId: string,
  access: PluginWorkspaceAccess,
): WorkspaceFileSystem {
  return createWorkspaceFileSystem(authorizedRoot(pluginId, access));
}

export function workspaceRead(
  pluginId: string,
  request: { path: string; startLine?: number; endLine?: number },
  access: PluginWorkspaceAccess,
): string {
  return authorizedWorkspace(pluginId, access).read(request.path, {
    startLine: request.startLine,
    endLine: request.endLine,
  });
}

export function workspaceWrite(
  pluginId: string,
  request: { path: string; content: string },
  access: PluginWorkspaceAccess,
): void {
  authorizedWorkspace(pluginId, access).write(request.path, request.content);
}

export function workspaceDelete(
  pluginId: string,
  request: { path: string },
  access: PluginWorkspaceAccess,
): void {
  authorizedWorkspace(pluginId, access).delete(request.path);
}

export function workspaceList(
  pluginId: string,
  request: { path: string },
  access: PluginWorkspaceAccess,
): WorkspaceEntry[] {
  return authorizedWorkspace(pluginId, access).list(request.path);
}

export function workspaceGlob(
  pluginId: string,
  request: { pattern: string },
  access: PluginWorkspaceAccess,
): string[] {
  return authorizedWorkspace(pluginId, access).glob(request.pattern);
}

export function workspaceGrep(
  pluginId: string,
  request: { pattern: string; path?: string },
  access: PluginWorkspaceAccess,
): WorkspaceGrepMatch[] {
  return authorizedWorkspace(pluginId, access).grep(request.pattern, { path: request.path });
}

export function workspaceSnapshot(
  pluginId: string,
  request: { path: string },
  access: PluginWorkspaceAccess,
): WorkspaceSnapshot | null {
  return authorizedWorkspace(pluginId, access).snapshot(request.path);
}

/** 路径表校成干净的相对路径列表：必须是字符串数组、有条数上限；同一路径只算一次。 */
function normalizeSymbolPaths(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new WorkspaceError('invalid-input', 'paths 必须是路径数组');
  }
  if (input.length > SYMBOLS_LIMITS.paths) {
    throw new WorkspaceError(
      'symbols-limit',
      `一次最多提取 ${SYMBOLS_LIMITS.paths} 个文件的符号`,
    );
  }
  const unique = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new WorkspaceError('invalid-input', 'paths 里只能是非空字符串');
    }
    unique.add(item);
  }
  return [...unique];
}

/**
 * 批量符号提取（分发计划 §11.4）。
 *
 * 与读 / glob 共用同一条路径约束，但**越界仍然抛错**而不是降级成「这个文件跳过」——越界是
 * 调用方的问题，不是数据的问题。反过来，文件不在或读不动只记在这一条上（`skipped`），一个
 * 坏路径不该让整批白跑。
 *
 * 增量：`digests` 是上一次结果里的 sha256，命中且内容没变的文件只回摘要与 `unchanged`，不再
 * 解析——第二次问同一批文件时，成本落在哈希上而不是解析上。预算（总字节 / 时间 / 条数）用完
 * 则返回已完成部分并带 `truncated`。
 */
export async function workspaceSymbols(
  pluginId: string,
  request: { paths: unknown; digests?: Record<string, string> },
  access: PluginWorkspaceAccess,
): Promise<WorkspaceSymbolsResult> {
  const root = authorizedRoot(pluginId, access);
  // 与其它方法一致：工作区目录按需创建，符号提取只读，但也不该因「目录还没建」报路径错
  mkdirSync(root, { recursive: true });
  const paths = normalizeSymbolPaths(request.paths);
  const previous = request.digests ?? {};
  const startedAt = Date.now();

  const files: WorkspaceSymbolsFile[] = [];
  let totalBytes = 0;
  let totalSymbols = 0;
  let truncated = false;

  for (const path of paths) {
    if (truncated) break;
    if (Date.now() - startedAt > SYMBOLS_LIMITS.budgetMs) {
      truncated = true;
      break;
    }

    const target = confine(root, path);
    const stats = statFile(target);
    if (!stats || !stats.isFile()) {
      files.push({
        path,
        sha256: null,
        bytes: 0,
        language: null,
        unchanged: false,
        skipped: 'not-found',
        symbols: [],
      });
      continue;
    }

    // 超过解析上限的文件不读：摘要只有配合符号才有用，而它这里注定没有符号
    if (stats.size > SYMBOLS_LIMITS.fileBytes) {
      files.push({
        path,
        sha256: null,
        bytes: stats.size,
        language: grammarForExt(extname(target).toLowerCase()),
        unchanged: false,
        skipped: 'too-large',
        symbols: [],
      });
      continue;
    }
    if (totalBytes + stats.size > SYMBOLS_LIMITS.totalBytes) {
      truncated = true;
      break;
    }
    totalBytes += stats.size;

    const text = readFileSync(target, 'utf8');
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const language = grammarForExt(extname(target).toLowerCase());

    if (previous[path] === sha256) {
      files.push({ path, sha256, bytes: stats.size, language, unchanged: true, skipped: null, symbols: [] });
      continue;
    }

    const extraction = await extractSymbolsAst(text, extname(target).toLowerCase(), SYMBOLS_LIMITS.perFile);
    if (!extraction) {
      // 语言不认识、语法文件缺失或解析异常：如实回空符号，包侧自己降级
      files.push({ path, sha256, bytes: stats.size, language, unchanged: false, skipped: null, symbols: [] });
      continue;
    }

    const room = Math.max(0, SYMBOLS_LIMITS.results - totalSymbols);
    const symbols = extraction.symbols.slice(0, room);
    if (extraction.truncated || symbols.length < extraction.symbols.length) truncated = true;
    totalSymbols += symbols.length;
    files.push({ path, sha256, bytes: stats.size, language, unchanged: false, skipped: null, symbols });
  }

  return { files, truncated };
}

/** 拉取会真的跑 git，命令可能很慢；探针类命令不该跟着一起等两分钟。 */
const SLOW_GIT_STEPS = new Set(['clone', 'fetch', 'reset']);

const defaultGitRunner: GitRunner = (args) =>
  runGit(args, {
    timeoutMs: args.some((arg) => SLOW_GIT_STEPS.has(arg))
      ? FETCH_LIMITS.timeoutMs
      : FETCH_LIMITS.probeTimeoutMs,
  });

/** 拉取失败的原因码 → 原语错误码：包侧只认一套码，不必知道 git 的退出码语义 */
const FETCH_ERROR_CODES: Record<FetchErrorCode, WorkspaceErrorCode> = {
  'invalid-url': 'fetch-invalid-url',
  'dir-occupied': 'fetch-dir-occupied',
  'origin-mismatch': 'fetch-origin-mismatch',
  'git-unavailable': 'fetch-unavailable',
  'limit-exceeded': 'fetch-limit',
  failed: 'fetch-failed',
};

/**
 * 从远端拉取到本包工作区（分发计划 §11.2 工作区原语的最后一行）。
 *
 * 两项声明都要：`filesystem:workspace`（落盘）与 `network:fetch`（网络出口）。两次授权都发生在
 * **建目录之前**——留一个「先建了目录再发现没授权」的窗口，等于让未授权的调用改了工作区状态。
 *
 * 目标目录同样过工作区约束（绝对路径 / `..` / 符号链接逸出一致处理），所以包拿到的是「本包目录
 * 里的一个相对位置」，不是任意磁盘路径；`dir` 省略时由地址推导（只可能是 `[a-z0-9._-]`）。
 */
export async function workspaceFetch(
  pluginId: string,
  request: { url: unknown; dir?: unknown },
  access: PluginWorkspaceAccess,
): Promise<WorkspaceFetchResult> {
  const root = authorizedRoot(pluginId, access);
  const network = access.permissionGateway.authorizePlugin({
    pluginId,
    permission: 'network:fetch',
  });
  if (!network.allowed) throw new WorkspaceAccessDeniedError(network.code);

  const url = validateFetchUrl(request.url);
  if (!url.ok) throw new WorkspaceError('fetch-invalid-url', url.reason);

  const dir = request.dir === undefined ? deriveDirName(url.url) : request.dir;
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new WorkspaceError('invalid-input', 'dir 必须是非空字符串');
  }

  mkdirSync(root, { recursive: true });
  const target = confine(root, dir);

  const result = await runFetch({ url: url.url, dir: target }, access.gitRun ?? defaultGitRunner);
  if (!result.ok) throw new WorkspaceError(FETCH_ERROR_CODES[result.code], result.detail);

  return {
    dir: relative(root, target).split(sep).join('/') || '.',
    ...result.outcome,
  };
}
