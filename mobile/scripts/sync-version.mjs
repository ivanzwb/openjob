// 从 GitHub tag 或根 package.json 同步 expo 版本号。
// 用法（在 mobile/ 目录下）: node scripts/sync-version.mjs
//
// 优先 GITHUB_REF_NAME（v0.3.0 / 0.3.0），否则读仓库根 package.json。
// 写入 package.json version、app.json expo.version、android.versionCode
// （major*10000 + minor*100 + patch）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(mobileRoot, '..');

function parseVersion(raw) {
  const trimmed = raw.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!m) return null;
  return {
    version: m.slice(1).join('.'),
    versionCode: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]),
  };
}

const ref = process.env.GITHUB_REF_NAME ?? '';
let parsed = parseVersion(ref);

if (!parsed) {
  try {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    parsed = parseVersion(String(rootPkg.version ?? ''));
    if (parsed) {
      console.log(`GITHUB_REF_NAME=${ref || '(空)'}，改从根 package.json 同步 ${parsed.version}`);
    }
  } catch {
    // 根 package.json 读失败时下面统一处理
  }
}

if (!parsed) {
  const msg = `无法从 GITHUB_REF_NAME=${ref} 或根 package.json 解析出版本号`;
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    console.error(`::error::${msg}`);
    process.exit(1);
  }
  console.log(`${msg}，跳过版本同步`);
  process.exit(0);
}

const { version, versionCode } = parsed;

const pkgPath = join(mobileRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const appPath = join(mobileRoot, 'app.json');
const app = JSON.parse(readFileSync(appPath, 'utf8'));
app.expo.version = version;
app.expo.android = { ...(app.expo.android ?? {}), versionCode };
writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');

console.log(`version 同步完成: ${version} (versionCode ${versionCode})`);
