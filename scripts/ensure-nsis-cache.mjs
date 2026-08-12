import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Work around electron-builder NSIS cache EPERM on Windows (Defender holds handles
 * during rename of extracted .tmp → final dir). If a stuck "extracting" entry exists
 * beside a complete one, remove the stuck copy so packaging reuses the good cache.
 *
 * See docs/DESIGN.md §「阶段 0 实施记录：Windows 构建的三个坑」.
 */
if (process.platform !== 'win32') {
  process.exit(0);
}

const cacheRoot = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'electron-builder',
  'Cache',
);

for (const tool of ['nsis-3.0.4.1', 'nsis-resources-3.4.1']) {
  repairToolCache(join(cacheRoot, tool));
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

  if (complete.length === 0 || stuck.length === 0) return;

  for (const item of stuck) {
    if (!looksExtracted(item.dirPath)) {
      console.warn(`[ensure-nsis-cache] Leaving incomplete extraction: ${item.dirPath}`);
      continue;
    }

    console.log(`[ensure-nsis-cache] Removing stuck cache dir ${item.name} (complete copy exists)`);
    rmSync(item.dirPath, { recursive: true, force: true });
    if (existsSync(item.statePath)) rmSync(item.statePath, { force: true });
  }

  // Orphan "extracting" state files (no matching dir) also trigger needless re-extracts.
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

// If a lone .tmp directory is fully extracted but rename failed, finalize it in place.
function finalizeLoneTmp(toolDir) {
  const entries = readdirSync(toolDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const tmpOnly = dirs.length === 1 && dirs[0].name.endsWith('.tmp');
  if (!tmpOnly) return;

  const tmpName = dirs[0].name;
  const finalName = tmpName.replace(/\.tmp$/, '');
  const tmpPath = join(toolDir, tmpName);
  const finalPath = join(toolDir, finalName);
  if (!looksExtracted(tmpPath) || existsSync(finalPath)) return;

  const { size, count } = measureDir(tmpPath);
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
  console.log(`[ensure-nsis-cache] Marked ${finalName} complete (${count} files)`);
}

for (const tool of ['nsis-3.0.4.1', 'nsis-resources-3.4.1']) {
  finalizeLoneTmp(join(cacheRoot, tool));
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
