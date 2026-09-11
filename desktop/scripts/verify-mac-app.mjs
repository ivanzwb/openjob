import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * CI smoke test: hardenedRuntime 下缺少 JIT entitlement 的 mac 包能正常打出来、
 * 却会在启动时于 v8::Isolate::Initialize 直接 SIGTRAP。这里在发布前检查签名与
 * entitlements，把这类只有装到 Mac 上才暴露的问题挡在 CI。
 */
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
];

const apps = process.argv[2] ? [resolve(process.argv[2])] : findApps(resolve(process.cwd(), 'dist'));

if (apps.length === 0) {
  console.error('[verify-mac] No .app bundle found under dist/');
  process.exit(1);
}

let failed = false;
for (const app of apps) {
  console.log(`[verify-mac] Checking ${app}`);

  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    encoding: 'utf8',
  });
  if (verify.status !== 0) {
    console.error(`[verify-mac] Signature invalid:\n${verify.stderr ?? ''}`);
    failed = true;
    continue;
  }

  const dump = spawnSync('codesign', ['-d', '--entitlements', ':-', app], { encoding: 'utf8' });
  const entitlements = `${dump.stdout ?? ''}${dump.stderr ?? ''}`;
  const missing = REQUIRED_ENTITLEMENTS.filter((key) => !entitlements.includes(key));
  if (missing.length > 0) {
    console.error(`[verify-mac] Missing entitlements: ${missing.join(', ')}`);
    console.error(entitlements.trim());
    failed = true;
    continue;
  }

  console.log(`[verify-mac] Signature + entitlements OK (${REQUIRED_ENTITLEMENTS.length} keys)`);
}

if (failed) process.exit(1);

function findApps(distDir) {
  if (!existsSync(distDir)) return [];
  const found = [];
  for (const entry of readdirSync(distDir)) {
    // electron-builder 按架构输出 mac / mac-arm64 / mac-universal 等目录
    if (!entry.startsWith('mac')) continue;
    const dir = join(distDir, entry);
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.app')) found.push(join(dir, name));
    }
  }
  return found;
}
