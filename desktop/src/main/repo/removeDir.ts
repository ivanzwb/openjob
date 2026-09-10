import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 删整棵目录树，必要时先摘掉只读属性。
 *
 * git 把 .git/objects 下的松散对象和 pack 文件标成只读，Windows 上对只读文件
 * unlink 会返回 EPERM。rmSync 的 force 只压制 ENOENT，不碰权限位，所以删 clone
 * 会以「permission denied」失败，而且失败后仓库记录也删不掉，条目永远赖在列表里。
 *
 * 先直接删是因为绝大多数目录没有只读文件，遍历改权限纯属白跑；只有真的撞上
 * 权限错误才回退到清属性重删。
 */
export function removeDirTree(path: string): void {
  try {
    rmSync(path, RM_OPTIONS);
    return;
  } catch (err) {
    if (!isPermissionError(err)) throw err;
  }

  clearReadOnly(path);
  rmSync(path, RM_OPTIONS);
}

/** EBUSY / EPERM 这类瞬时占用交给 rmSync 自己重试，杀毒和索引器扫文件时常见 */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const;

function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

function clearReadOnly(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }

  // chmod 会跟随符号链接，改到树外的文件上去；链接本身交给 rmSync 摘掉就行
  if (stat.isSymbolicLink()) return;

  try {
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  } catch {
    // 改不动的继续往下走，让 rmSync 去报真正的错，别在这里提前中断
  }

  if (!stat.isDirectory()) return;

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return;
  }
  for (const entry of entries) clearReadOnly(join(path, entry));
}
