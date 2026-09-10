import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * CI smoke test: ensure the NSIS installer is not corrupt and can extract silently.
 * Catches incomplete NSIS cache / truncated builds before publishing to GitHub Releases.
 */
const distDir = resolve(process.cwd(), 'dist');
const exe = process.argv[2] ?? findInstaller(distDir);

if (!exe) {
  console.error('[verify-installer] No Windows installer found in dist/');
  process.exit(1);
}

console.log(`[verify-installer] Testing ${exe}`);
console.log(`[verify-installer] SHA256 ${sha256(exe)}`);

const installDir = mkdtempSync(join(tmpdir(), 'openjob-install-'));
try {
  const result = spawnSync(
    exe,
    ['/S', `/D=${installDir}`],
    { stdio: 'inherit', timeout: 5 * 60 * 1000 },
  );

  if (result.error) {
    console.error('[verify-installer] Failed to launch installer:', result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[verify-installer] Installer exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }

  const appExe = ['openJob.exe', 'OpenJob.exe']
    .map((name) => join(installDir, name))
    .find((path) => existsSync(path));

  if (!appExe) {
    console.error('[verify-installer] Installed app executable not found under', installDir);
    process.exit(1);
  }

  console.log('[verify-installer] Silent install OK:', appExe);
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

/**
 * CI 的 dist/ 是干净的，随便取一个 .exe 都对；本机重复打包时 dist/ 会堆着历史版本，
 * 取到旧包就成了「验证通过但验的不是这次的产物」。优先按当前 package.json 版本认，
 * 认不出再退回最新修改时间。
 */
function findInstaller(dir) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir).filter(
    (name) => name.endsWith('.exe') && !name.startsWith('Uninstall'),
  );
  if (candidates.length === 0) return null;

  const { version } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const current = candidates.find((name) => name.includes(version));
  if (current) return join(dir, current);

  const newest = candidates
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].name;
  console.log(`[verify-installer] 未找到 ${version} 的安装包，改用最新的 ${newest}`);
  return join(dir, newest);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
