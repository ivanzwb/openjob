import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

function searchFile(file: string, regex: RegExp, rel: string): string[] {
  const content = readFileSync(file, 'utf8');
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
