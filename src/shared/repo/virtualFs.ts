import { SKIP_DIRS, TEXT_EXT } from './constants';

export function normalizeRepoPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

export function listDirFromPaths(filePaths: string[], relPath = '.'): string {
  const base = normalizeRepoPath(relPath);
  const prefix = base === '.' ? '' : `${base}/`;
  const dirs = new Set<string>();
  const files = new Set<string>();

  for (const raw of filePaths) {
    const path = normalizeRepoPath(raw);
    if (base !== '.' && path !== base && !path.startsWith(prefix)) continue;
    const rest = base === '.' ? path : path.slice(prefix.length);
    if (!rest || rest === '.') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.add(rest);
    } else {
      const first = rest.slice(0, slash);
      if (first && !SKIP_DIRS.has(first)) dirs.add(first);
    }
  }

  const lines: string[] = [];
  for (const d of [...dirs].sort()) lines.push(`[dir] ${base === '.' ? d : `${base}/${d}`}`);
  for (const f of [...files].sort()) lines.push(`[file] ${base === '.' ? f : `${base}/${f}`}`);
  return lines.join('\n') || '（空目录）';
}

export function readFileRangeFromContent(
  content: string,
  startLine = 1,
  endLine?: number,
): { content: string; totalLines: number; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, startLine);
  const end = Math.min(endLine ?? start + 199, total);
  const slice = lines.slice(start - 1, end);
  const numbered = slice.map((l, i) => `${start + i}|${l}`).join('\n');
  return { content: numbered, totalLines: total, startLine: start, endLine: end };
}

export function grepFileContents(
  files: Array<{ path: string; content: string }>,
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

  const base = normalizeRepoPath(relPath);
  const prefix = base === '.' ? '' : `${base}/`;
  const results: string[] = [];

  for (const file of files) {
    if (results.length >= maxMatches) break;
    const path = normalizeRepoPath(file.path);
    if (base !== '.' && path !== base && !path.startsWith(prefix)) continue;
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      results.push(`${path}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      if (results.length >= maxMatches) break;
    }
  }

  return results.join('\n') || '未找到匹配';
}

export function isTextFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXT.has(name.slice(dot));
}

export function joinRepoPath(base: string, name: string): string {
  if (!base || base === '.') return normalizeRepoPath(name);
  return normalizeRepoPath(`${base}/${name}`);
}
