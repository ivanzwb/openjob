import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STABLE_ROOT = join(process.cwd(), 'build', '.toolchain');

export function repairNsisCaches() {
  if (process.platform !== 'win32') return;

  const cacheRoot = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
  );

  for (const tool of ['nsis-3.0.4.1', 'nsis-resources-3.4.1']) {
    repairToolCache(join(cacheRoot, tool));
  }
}

export function resolveStableToolchainDirs() {
  if (process.platform !== 'win32') {
    return { nsisDir: null, nsisResourcesDir: null };
  }

  const cacheRoot = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
  );

  const nsisSource = findCompleteDir(join(cacheRoot, 'nsis-3.0.4.1'), (dir) =>
    existsSync(join(dir, 'makensis.exe')),
  );
  const resourcesSource = findCompleteDir(join(cacheRoot, 'nsis-resources-3.4.1'), (dir) =>
    existsSync(join(dir, 'plugins')),
  );

  const nsisDir = nsisSource ? materializeStable('nsis', nsisSource) : null;
  const nsisResourcesDir = resourcesSource ? materializeStable('nsis-resources', resourcesSource) : null;

  return { nsisDir, nsisResourcesDir };
}

function repairToolCache(toolDir) {
  if (!existsSync(toolDir)) return;

  const entries = readdirSync(toolDir, { withFileTypes: true });
  const complete = [];
  const stuck = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(toolDir, entry.name);
    const statePath = join(toolDir, `${entry.name}.state`);
    const state = readState(statePath);

    if (state?.state === 'complete') {
      complete.push({ name: entry.name, dirPath, statePath, state });
      continue;
    }

    if (entry.name.endsWith('.tmp') || state?.state === 'extracting') {
      stuck.push({ name: entry.name, dirPath, statePath, state });
    }
  }

  for (const item of stuck) {
    if (complete.length === 0) {
      finalizeExtraction(toolDir, item);
      continue;
    }

    if (!looksExtracted(item.dirPath)) {
      console.warn(`[ensure-nsis-cache] Leaving incomplete extraction: ${item.dirPath}`);
      continue;
    }

    console.log(`[ensure-nsis-cache] Removing stuck cache dir ${item.name} (complete copy exists)`);
    rmSync(item.dirPath, { recursive: true, force: true });
    if (existsSync(item.statePath)) rmSync(item.statePath, { force: true });
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.state')) continue;
    const statePath = join(toolDir, entry.name);
    const state = readState(statePath);
    if (state?.state !== 'extracting') continue;
    const dirName = entry.name.replace(/\.state$/, '');
    if (existsSync(join(toolDir, dirName))) continue;
    if (complete.length === 0) continue;
    console.log(`[ensure-nsis-cache] Removing orphan extracting state ${entry.name}`);
    rmSync(statePath, { force: true });
  }
}

function finalizeExtraction(toolDir, item) {
  if (!looksExtracted(item.dirPath)) return;
  const finalName = item.name.replace(/\.tmp$/, '');
  const finalPath = join(toolDir, finalName);
  if (existsSync(finalPath)) return;

  try {
    // Prefer rename; fall back to copy when Defender still holds a handle.
    const { renameSync } = require('node:fs');
    renameSync(item.dirPath, finalPath);
  } catch {
    cpSync(item.dirPath, finalPath, { recursive: true });
    rmSync(item.dirPath, { recursive: true, force: true });
  }

  const { size, count } = measureDir(finalPath);
  writeFileSync(
    join(toolDir, `${finalName}.state`),
    JSON.stringify({
      version: 1,
      state: 'complete',
      timestamp: Date.now(),
      fileCount: count,
      extractedSize: size,
    }),
  );
  console.log(`[ensure-nsis-cache] Finalized ${finalName}`);
}

function findCompleteDir(toolDir, predicate) {
  if (!existsSync(toolDir)) return null;
  const candidates = readdirSync(toolDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(toolDir, entry.name))
    .filter(predicate)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function materializeStable(name, sourceDir) {
  const targetDir = join(STABLE_ROOT, name);
  const stampFile = join(targetDir, '.source');
  const sourceStamp = `${sourceDir}:${statSync(sourceDir).mtimeMs}`;

  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === sourceStamp) {
    return targetDir;
  }

  mkdirSync(STABLE_ROOT, { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  writeFileSync(stampFile, sourceStamp, 'utf8');
  console.log(`[ensure-nsis-cache] Synced stable ${name} toolchain from ${sourceDir}`);
  return targetDir;
}

function readState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function looksExtracted(dirPath) {
  if (!existsSync(dirPath)) return false;
  const markers = ['makensis.exe', 'Bin', 'plugins', 'elevate.exe'];
  return markers.some((name) => existsSync(join(dirPath, name)));
}

function measureDir(root) {
  let size = 0;
  let count = 0;
  walk(root);
  return { size, count };

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        count++;
        size += statSync(path).size;
      }
    }
  }
}
