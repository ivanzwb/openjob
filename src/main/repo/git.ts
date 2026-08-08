import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitStatus } from '@shared/ipc';

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

/**
 * 真的执行一次 `git --version`。
 *
 * 光看路径存不存在没有意义——PATH 里的 `git` 是否可用只有跑一次才知道，
 * 而 clone 直接失败时用户看到的是 spawn ENOENT，根本不知道该去装 Git。
 */
const MISSING_GIT =
  '未找到可用的 Git。请安装 Git（Windows 用 Git for Windows），' +
  '安装后确保 git 在 PATH 中，或用环境变量 GIT_EXECUTABLE 指定完整路径。';

/** 探测结果：装了就返回版本号，没装返回 null */
export function gitVersion(): string | null {
  try {
    const out = execFileSync(resolveGitBinary(), ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    verified = true;
    return out.trim();
  } catch {
    return null;
  }
}

export function assertGitAvailable(): void {
  if (verified) return;
  if (!gitVersion()) throw new Error(MISSING_GIT);
}

/** 供 UI 提前告知用户，而不是等 clone 到一半才失败 */
export function getGitStatus(): GitStatus {
  const version = gitVersion();
  return {
    available: version !== null,
    version,
    hint: version === null ? MISSING_GIT : null,
  };
}
