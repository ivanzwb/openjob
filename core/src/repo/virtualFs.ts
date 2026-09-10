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

/**
 * glob 转正则。`**\/` 跨任意层目录，`*` 和 `?` 不跨 `/`，整体大小写不敏感
 * （模型给的大小写常常是错的，Windows 上又本来就不区分）。
 */
export function globToRegExp(pattern: string): RegExp {
  const glob = normalizeRepoPath(pattern);
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // 零层也要匹配，这样 **/a.ts 能命中根目录下的 a.ts
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * 按文件名或 glob 在路径清单里找文件。
 *
 * 缺了这个能力，模型想定位一个文件时只有两条路：grep 内容，或者一层层 list_dir。
 * 两条都比「按印象编一个路径」费劲，于是它就编了。短路径优先，因为同名文件里
 * 顶层的那个通常才是被问到的那个。
 */
export function globFromPaths(filePaths: string[], pattern: string, limit = 60): string[] {
  const raw = normalizeRepoPath(pattern);
  if (!raw || raw === '.') return [];
  // 只给了个文件名就当「在任意目录下找它」——模型问得最多的正是「agent.ts 在哪」。
  // 带通配符的一律按写下来的字面意思处理，否则 *.ts 只匹配根目录、a?.ts 却满仓库找，
  // 同一个位置两个通配符两种行为，没法用。
  const isPlainName = !raw.includes('/') && !/[*?]/.test(raw);
  const glob = isPlainName ? `**/${raw}` : raw;
  const re = globToRegExp(glob);

  const hits = new Set<string>();
  for (const p of filePaths) {
    const path = normalizeRepoPath(p);
    if (re.test(path)) hits.add(path);
  }
  return [...hits]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
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
