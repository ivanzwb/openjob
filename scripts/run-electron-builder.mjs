import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repairNsisCaches, resolveStableToolchainDirs } from './lib/nsis-toolchain.mjs';

repairNsisCaches();

const toolchain = resolveStableToolchainDirs();
const env = { ...process.env };

if (toolchain.nsisDir) {
  env.ELECTRON_BUILDER_NSIS_DIR = toolchain.nsisDir;
  console.log(`[electron-builder] ELECTRON_BUILDER_NSIS_DIR=${toolchain.nsisDir}`);
}

if (toolchain.nsisResourcesDir) {
  env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = toolchain.nsisResourcesDir;
  console.log(`[electron-builder] ELECTRON_BUILDER_NSIS_RESOURCES_DIR=${toolchain.nsisResourcesDir}`);
}

const args = process.argv.slice(2);
const localBin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const command = existsSync(localBin) ? localBin : 'electron-builder';

const result = spawnSync(command, args, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
