// 从 GitHub tag 同步 expo 版本号。
// 用法（在 mobile/ 目录下）: node scripts/sync-version.mjs
//
// 仅当 GITHUB_REF_NAME 形如 vX.Y.Z（例如 v0.3.0）时生效，同步到：
//   - package.json  version
//   - app.json      expo.version      → versionName
//   - app.json      expo.android.versionCode → versionCode（x*10000 + y*100 + z）
// 非版本 tag / 手动 dispatch（分支名）时跳过，保持仓库现有版本不变。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.env.GITHUB_REF_NAME ?? '';

const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(ref);
if (!m) {
  console.log(`GITHUB_REF_NAME=${ref} 不是 vX.Y.Z 版本 tag，跳过版本同步`);
  process.exit(0);
}
const version = m.slice(1).join('.');
const versionCode = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);

// package.json
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// app.json
const appPath = join(root, 'app.json');
const app = JSON.parse(readFileSync(appPath, 'utf8'));
app.expo.version = version;
app.expo.android = { ...(app.expo.android ?? {}), versionCode };
writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');

console.log(`version 同步完成: ${version} (versionCode ${versionCode})`);