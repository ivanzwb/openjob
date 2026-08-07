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

export function assertGitAvailable(): void {
  // clone 失败时 simple-git 会抛错；此处仅作提示性检查
  const bin = resolveGitBinary();
  if (bin !== 'git' && !existsSync(bin)) {
    throw new Error(
      '未找到 Git。请安装 Git for Windows 或将 git 加入 PATH。',
    );
  }
}
