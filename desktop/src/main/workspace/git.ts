/**
 * 通用 git 管道（宿主侧）。
 *
 * 这一层不认任何岗位，只做三件事：找到 git、按**固定 argv** 跑一条命令、把子进程的环境收紧到
 * 「不读用户配置、不弹凭据、不执行仓库里的东西」。
 *
 * 环境为什么必须收紧：clone 一个不可信仓库时，`~/.gitconfig` 里的 credential helper、
 * `url.<x>.insteadOf` 改写、`filter.*` 程序、`core.hooksPath` 都会被 git 读进来并执行。
 * 岗位实现用用户自己的配置是对的（那拉的是用户自己的仓库），**插件的拉取不能**。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Git 可执行文件路径。Windows 上常不在 PATH，需扫描常见安装位置。 */
export function resolveGitBinary(): string {
  const candidates = [
    process.env['GIT_EXECUTABLE'],
    process.env['GIT_PATH'],
    'git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c === 'git' || existsSync(c)) return c;
  }
  return 'git';
}

/**
 * 只在进程内缓存成功的结果：用户装完 git 不该被迫重启应用，
 * 但装好之后也不必每次 clone 都再探测一遍。
 */
let verified = false;

export const MISSING_GIT =
  '未找到可用的 Git。请安装 Git（Windows 用 Git for Windows），' +
  '安装后确保 git 在 PATH 中，或用环境变量 GIT_EXECUTABLE 指定完整路径。';

/** 探测结果：装了就返回版本号，没装返回 null */
export function gitVersion(): string | null {
  try {
    const out = execFileSync(resolveGitBinary(), ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: hardenedGitEnv(),
    });
    verified = true;
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function assertGitAvailable(): void {
  if (verified) return;
  if (!gitVersion()) throw new Error(MISSING_GIT);
}

function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * 子进程环境：把「读用户配置」与「要凭据」两条入口都堵掉。
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向空设备（git ≥ 2.32），再叠一层
 * `GIT_CONFIG_NOSYSTEM` 覆盖老版本；`GIT_TERMINAL_PROMPT=0` + 空 `GIT_ASKPASS` 保证
 * 需要认证时直接失败，而不是弹一个凭据窗口问用户（插件的拉取不该有这个界面）。
 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_CONFIG_SYSTEM: nullDevice(),
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

/**
 * 每条命令都带上的加固参数。
 *
 * - `protocol.ext.allow=never`：`ext::` 传输会执行任意命令（URL 校验已拒，这里再堵一层）；
 * - `credential.helper=`：清空助手，即使某个仓库自带配置也拿不到钥匙串；
 * - `core.symlinks=false`：不落地符号链接，仓库里写的 `link -> C:\...` 只会变成普通文本文件
 *   ——工作区原语本来就不跟随链接，这里让它在**文件系统里就不成立**。
 */
export const HARDENING_ARGS: readonly string[] = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'credential.helper=',
  '-c',
  'core.symlinks=false',
];

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 是否因为超时被宿主掐断（此时的 code 没有意义） */
  timedOut: boolean;
}

export interface GitRunOptions {
  timeoutMs: number;
  /** 输出收集上限，防止一条命令把内存吃满 */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 64 * 1024;

/**
 * 超时要连子进程一起杀。
 *
 * Windows 上 `child.kill()` 只结束 git 自己，`git-remote-https` 会留在原地继续占着网络与目标
 * 目录的句柄——下一次 clone 就会撞上「目录非空/被占用」这种莫名其妙的现象。
 */
function killTree(pid: number, child: { kill(signal?: NodeJS.Signals): boolean }): void {
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
      return;
    }
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程可能已经退出，掐不到不算错
  }
}

/**
 * 跑一条 git 命令：**固定 argv、不经 shell**（数组形式），输出有上限，超时杀整棵树。
 *
 * 参数里绝不拼用户输入以外的选项——URL 与目录都先过校验，且调用方在 URL 前加 `--`
 * 终止选项解析，避免 `--upload-pack=...` 这类选项注入。
 */
export function runGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const binary = resolveGitBinary();

  return new Promise<GitRunResult>((resolve) => {
    let child;
    try {
      child = spawn(binary, [...HARDENING_ARGS, ...args], {
        env: hardenedGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const collect = (into: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (into === 'stdout') {
        if (stdout.length < maxOutput) stdout += text.slice(0, maxOutput - stdout.length);
        return;
      }
      if (stderr.length < maxOutput) stderr += text.slice(0, maxOutput - stderr.length);
    };

    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid, child);
      finish(-1);
    }, options.timeoutMs);

    child.on('error', (error) => {
      stderr = stderr || String(error);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}
