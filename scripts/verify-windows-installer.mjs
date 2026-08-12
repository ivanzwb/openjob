import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

function findInstaller(dir) {
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find((name) => name.endsWith('.exe') && !name.startsWith('Uninstall'));
  return match ? join(dir, match) : null;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
