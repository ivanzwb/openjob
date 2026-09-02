import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  readdir as readdirAsync,
  readFile as readFileAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { globFromPaths } from '@shared/repo/virtualFs';
import {
  findSymbolsInAsyncFiles,
  findSymbolsInFiles,
  formatSymbolMatches,
} from '@shared/repo/symbolScan';

/** 超过这个大小的文件不进内容扫描：压缩产物和数据文件扫了也没意义 */
const MAX_SCAN_FILE_BYTES = 512_000;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'vendor',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.md',
  '.json', '.yaml', '.yml', '.toml', '.sql', '.sh', '.vue', '.svelte',
]);

/** 确保路径在仓库根目录内，防止 path traversal */
export function safeRepoPath(repoRoot: string, relPath: string): string {
  const root = resolve(repoRoot);
  const target = resolve(root, relPath || '.');
  const rel = relative(root, target);
  if (rel.startsWith('..')) {
    throw new Error('路径越界');
  }
  return target;
}

export function listDir(repoRoot: string, relPath = '.'): string {
  const dir = safeRepoPath(repoRoot, relPath);
  const entries = readdirSync(dir, { withFileTypes: true });
  const lines: string[] = [];

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(e.name)) continue;
    const prefix = e.isDirectory() ? '[dir] ' : '[file]';
    lines.push(`${prefix}${join(relPath === '.' ? '' : relPath, e.name).replace(/\\/g, '/')}`);
  }

  return lines.join('\n') || '（空目录）';
}

export async function listDirAsync(repoRoot: string, relPath = '.'): Promise<string> {
  const dir = safeRepoPath(repoRoot, relPath);
  const entries = await readdirAsync(dir, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .map((entry) => {
      const prefix = entry.isDirectory() ? '[dir] ' : '[file]';
      return `${prefix}${join(relPath === '.' ? '' : relPath, entry.name).replace(/\\/g, '/')}`;
    });
  return lines.join('\n') || '（空目录）';
}

/**
 * 仓库里的相对路径清单，给 glob 用。
 *
 * 不复用 repo_file 快照：快照有条数和体积上限，桌面端手上是完整的 clone，
 * 按名字找文件这件事没道理比手机端找得少。上限只是防着超大仓库把内存撑爆。
 */
export function listAllFiles(repoRoot: string, max = 20_000): string[] {
  const out: string[] = [];

  const walk = (dir: string, relBase: string): void => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const rel = relBase === '.' ? e.name : `${relBase}/${e.name}`;
      if (e.isDirectory()) {
        walk(join(dir, e.name), rel);
      } else {
        out.push(rel);
      }
    }
  };

  walk(repoRoot, '.');
  return out;
}

export async function listAllFilesAsync(
  repoRoot: string,
  max = 20_000,
): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string, relBase: string): Promise<void> => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdirAsync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = relBase === '.' ? entry.name : `${relBase}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };

  await walk(repoRoot, '.');
  return out;
}

export function globRepo(repoRoot: string, pattern: string): string {
  const hits = globFromPaths(listAllFiles(repoRoot), pattern);
  return hits.join('\n') || '未找到匹配的文件';
}

export async function globRepoAsync(repoRoot: string, pattern: string): Promise<string> {
  const hits = globFromPaths(await listAllFilesAsync(repoRoot), pattern);
  return hits.join('\n') || '未找到匹配的文件';
}

/** 惰性读盘：符号扫描一次要过整个仓库，没必要先把所有文件内容堆进内存 */
function* iterateTextFiles(repoRoot: string): Generator<{ path: string; content: string }> {
  for (const rel of listAllFiles(repoRoot)) {
    const dot = rel.lastIndexOf('.');
    if (dot < 0 || !TEXT_EXT.has(rel.slice(dot))) continue;
    const full = join(repoRoot, rel);
    try {
      if (statSync(full).size > MAX_SCAN_FILE_BYTES) continue;
      yield { path: rel, content: readFileSync(full, 'utf8') };
    } catch {
      continue;
    }
  }
}

export function findSymbolRepo(repoRoot: string, name: string): string {
  return formatSymbolMatches(findSymbolsInFiles(iterateTextFiles(repoRoot), name));
}

async function* iterateTextFilesAsync(
  repoRoot: string,
): AsyncGenerator<{ path: string; content: string }> {
  for (const rel of await listAllFilesAsync(repoRoot)) {
    const dot = rel.lastIndexOf('.');
    if (dot < 0 || !TEXT_EXT.has(rel.slice(dot))) continue;
    const full = join(repoRoot, rel);
    try {
      if ((await statAsync(full)).size > MAX_SCAN_FILE_BYTES) continue;
      yield { path: rel, content: await readFileAsync(full, 'utf8') };
    } catch {
      continue;
    }
  }
}

export async function findSymbolRepoAsync(repoRoot: string, name: string): Promise<string> {
  return formatSymbolMatches(
    await findSymbolsInAsyncFiles(iterateTextFilesAsync(repoRoot), name),
  );
}

export function readFileRange(
  repoRoot: string,
  relPath: string,
  startLine = 1,
  endLine?: number,
): { content: string; totalLines: number; startLine: number; endLine: number } {
  const file = safeRepoPath(repoRoot, relPath);
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, startLine);
  const end = Math.min(endLine ?? start + 199, total);
  const slice = lines.slice(start - 1, end);

  const numbered = slice.map((l, i) => `${start + i}|${l}`).join('\n');
  return { content: numbered, totalLines: total, startLine: start, endLine: end };
}

export async function readFileRangeAsync(
  repoRoot: string,
  relPath: string,
  startLine = 1,
  endLine?: number,
): Promise<{ content: string; totalLines: number; startLine: number; endLine: number }> {
  const file = safeRepoPath(repoRoot, relPath);
  const raw = await readFileAsync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, startLine);
  const end = Math.min(endLine ?? start + 199, total);
  const slice = lines.slice(start - 1, end);
  const numbered = slice.map((line, index) => `${start + index}|${line}`).join('\n');
  return { content: numbered, totalLines: total, startLine: start, endLine: end };
}

export function grepRepo(
  repoRoot: string,
  pattern: string,
  relPath = '.',
  maxMatches = 40,
): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const results: string[] = [];
  const root = safeRepoPath(repoRoot, relPath);

  const walk = (dir: string): void => {
    if (results.length >= maxMatches) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxMatches) return;
      const full = join(dir, e.name);
      const rel = relative(repoRoot, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (TEXT_EXT.has(e.name.slice(e.name.lastIndexOf('.')))) {
        try {
          if (statSync(full).size > 512_000) continue;
        } catch {
          continue;
        }
        const hits = searchFile(full, regex, rel);
        for (const h of hits) {
          results.push(h);
          if (results.length >= maxMatches) return;
        }
      }
    }
  };

  walk(root);
  return results.join('\n') || '未找到匹配';
}

export async function grepRepoAsync(
  repoRoot: string,
  pattern: string,
  relPath = '.',
  maxMatches = 40,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const results: string[] = [];
  const root = safeRepoPath(repoRoot, relPath);

  const walk = async (dir: string): Promise<void> => {
    if (results.length >= maxMatches) return;
    let entries;
    try {
      entries = await readdirAsync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxMatches) return;
      const full = join(dir, entry.name);
      const rel = relative(repoRoot, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!TEXT_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue;
      try {
        if ((await statAsync(full)).size > MAX_SCAN_FILE_BYTES) continue;
        const hits = searchContent(await readFileAsync(full, 'utf8'), regex, rel);
        for (const hit of hits) {
          results.push(hit);
          if (results.length >= maxMatches) return;
        }
      } catch {
        continue;
      }
    }
  };

  await walk(root);
  return results.join('\n') || '未找到匹配';
}

function searchFile(file: string, regex: RegExp, rel: string): string[] {
  return searchContent(readFileSync(file, 'utf8'), regex, rel);
}

function searchContent(content: string, regex: RegExp, rel: string): string[] {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      out.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
    }
  }
  return out.slice(0, 10);
}

/** 生成目录树 + 关键文件头摘要，作为 Agent 导航地图 */
export function buildRepoMap(repoRoot: string, maxFiles = 80): string {
  const lines: string[] = ['# Repo Map', ''];
  let count = 0;

  const walk = (dir: string, depth: number): void => {
    if (count >= maxFiles || depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (count >= maxFiles) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const indent = '  '.repeat(depth);
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        walk(full, depth + 1);
      } else {
        const ext = e.name.slice(e.name.lastIndexOf('.'));
        if (!TEXT_EXT.has(ext)) continue;
        lines.push(`${indent}${e.name}`);
        count++;
        try {
          if (statSync(full).size < 100_000) {
            const head = readFileSync(full, 'utf8').split(/\r?\n/).slice(0, 8).join('\n');
            if (head.trim()) {
              lines.push(
                `${indent}  ---\n${head.split('\n').map((l) => `${indent}  ${l}`).join('\n')}`,
              );
            }
          }
        } catch {
          // 二进制或编码问题，跳过摘要
        }
      }
    }
  };

  walk(repoRoot, 0);
  return lines.join('\n');
}

/** 检测仓库主要语言（按扩展名计数） */
export function detectLanguages(repoRoot: string): string[] {
  const counts = new Map<string, number>();
  const extLang: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
    '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.swift': 'Swift', '.cpp': 'C++', '.c': 'C',
  };

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else {
        const ext = e.name.slice(e.name.lastIndexOf('.'));
        const lang = extLang[ext];
        if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      }
    }
  };

  walk(repoRoot);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);
}
