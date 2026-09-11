/**
 * 第一方发布公钥。
 *
 * 与 tree-sitter 语法文件同样的定位方式（见 src/main/repo/treeSitter.ts）：打包后
 * extraResources 把 resources/ 铺到 resourcesPath 根下，开发期回落到 cwd。刻意不 import
 * electron，这样本模块可以直接单测。
 *
 * 找不到密钥文件时返回空列表，于是所有外置包都只能是 unknown-signer，得由用户显式信任。
 * 这是有意的失败方向：宁可让第一方包也需要确认，也不能在缺钥匙时放行任何签名。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_FILE = 'plugin-keys.json';

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.resourcesPath) dirs.push(process.resourcesPath);
  dirs.push(join(process.cwd(), 'resources'));
  return dirs;
}

export function loadTrustedPublicKeys(dirs: readonly string[] = candidateDirs()): string[] {
  for (const dir of dirs) {
    const path = join(dir, KEY_FILE);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { keys?: unknown };
      if (!Array.isArray(parsed.keys)) return [];
      return parsed.keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
    } catch {
      // 密钥文件坏了等于没有可信密钥，不能退化成「跳过签名校验」
      return [];
    }
  }
  return [];
}
