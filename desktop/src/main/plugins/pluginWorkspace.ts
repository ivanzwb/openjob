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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app } from 'electron';
import { isStablePluginId } from '@core/plugins/contracts';
import type {
  WorkspaceEntry,
  WorkspaceGrepMatch,
  WorkspaceSnapshot,
} from '@core/plugins/pluginRuntime/host';
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
  | 'list-limit';

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

/** 服务层入参：网关每次调用都过一道；`root` 是测试用的夹具覆盖。 */
export interface PluginWorkspaceAccess {
  permissionGateway: PluginPermissionGateway;
  /** Test seam；生产按 pluginId 解析到 userData 下的本包工作区 */
  root?: string;
}

/** 逐次校验权限，然后返回绑定到本包工作区的文件系统。 */
function authorizedWorkspace(
  pluginId: string,
  access: PluginWorkspaceAccess,
): WorkspaceFileSystem {
  const decision = access.permissionGateway.authorizePlugin({
    pluginId,
    permission: 'filesystem:workspace',
  });
  if (!decision.allowed) throw new WorkspaceAccessDeniedError(decision.code);
  return createWorkspaceFileSystem(access.root ?? pluginWorkspaceRoot(pluginId));
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
