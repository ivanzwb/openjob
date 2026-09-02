/**
 * 按名字找符号定义（函数 / 类 / 接口 / 类型）。
 *
 * 这是 glob 之外另一个模型原本只能靠猜的问题：glob 回答「文件在哪」，这个回答
 * 「这个函数在哪」。缺了它，模型想定位一个函数只能拿名字去 grep 内容，命中的
 * 大多是调用点而不是定义处，于是它更倾向于按印象编一条路径。
 *
 * 故意用正则而不是 tree-sitter：手机端跑不了 tree-sitter，走正则两端才能共用
 * 同一份实现；而且不必预先建索引落库，已经克隆过的仓库立刻就能用。代价是偶尔
 * 漏掉写法花哨的定义——对「先找到真实路径再去读」这个用途够了。
 */

import { normalizeRepoPath } from './virtualFs';

export interface SymbolMatch {
  path: string;
  name: string;
  kind: string;
  line: number;
}

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.swift': 'swift',
};

export const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^(?:export\s+)?interface\s+(\w+)/,
    /^(?:export\s+)?type\s+(\w+)/,
    /^(?:export\s+)?const\s+(\w+)\s*=/,
  ],
  javascript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^(?:export\s+)?const\s+(\w+)\s*=/,
  ],
  python: [/^def\s+(\w+)/, /^class\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s+)?(\w+)/, /^type\s+(\w+)\s+/],
  rust: [/^(?:pub\s+)?fn\s+(\w+)/, /^(?:pub\s+)?struct\s+(\w+)/, /^(?:pub\s+)?enum\s+(\w+)/],
  java: [
    /^(?:public|private|protected).*(?:class|interface|enum)\s+(\w+)/,
    /^(?:public|private|protected).*\s+(\w+)\s*\(/,
  ],
};

export function langForExt(ext: string): string | undefined {
  return EXT_LANG[ext.toLowerCase()];
}

function langForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? undefined : langForExt(path.slice(dot));
}

function kindOfLine(line: string): string {
  if (line.includes('class')) return 'class';
  if (line.includes('interface')) return 'interface';
  if (line.includes('type ')) return 'type';
  return 'fn';
}

/** 一行里能认出来的符号名，认不出返回 null */
function symbolOnLine(line: string, patterns: RegExp[]): string | null {
  if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) return null;
  for (const re of patterns) {
    const m = line.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** 名字完全一致最优，其次前缀，最后子串；对不上返回 0 */
function rankName(name: string, target: string): number {
  const lower = name.toLowerCase();
  if (lower === target) return 3;
  if (lower.startsWith(target)) return 2;
  return lower.includes(target) ? 1 : 0;
}

export function extractSymbolNames(content: string, lang: string, limit = 30): Array<{
  name: string;
  kind: string;
  line: number;
}> {
  const patterns = SYMBOL_PATTERNS[lang] ?? SYMBOL_PATTERNS.typescript!;
  const lines = content.split(/\r?\n/);
  const hits: Array<{ name: string; kind: string; line: number }> = [];
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i]!.trim();
    const name = symbolOnLine(line, patterns);
    if (name) hits.push({ name, kind: kindOfLine(line), line: i + 1 });
  }
  return hits;
}

/**
 * 在若干文件里找名字匹配的符号定义。
 *
 * files 接受可迭代对象，桌面端可以传惰性读盘的生成器，不必把整仓内容先读进内存。
 */
export function findSymbolsInFiles(
  files: Iterable<{ path: string; content: string }>,
  query: string,
  limit = 40,
): SymbolMatch[] {
  const target = query.trim().toLowerCase();
  if (!target) return [];

  const ranked: Array<{ match: SymbolMatch; rank: number }> = [];
  for (const file of files) {
    const lang = langForPath(file.path);
    if (!lang) continue;
    const patterns = SYMBOL_PATTERNS[lang] ?? SYMBOL_PATTERNS.typescript!;
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      const name = symbolOnLine(line, patterns);
      if (!name) continue;
      const rank = rankName(name, target);
      if (rank === 0) continue;
      ranked.push({
        match: {
          path: normalizeRepoPath(file.path),
          name,
          kind: kindOfLine(line),
          line: i + 1,
        },
        rank,
      });
    }
  }

  ranked.sort(
    (a, b) =>
      b.rank - a.rank ||
      a.match.path.length - b.match.path.length ||
      a.match.path.localeCompare(b.match.path) ||
      a.match.line - b.match.line,
  );
  return ranked.slice(0, limit).map((r) => r.match);
}

export function formatSymbolMatches(matches: SymbolMatch[]): string {
  if (matches.length === 0) return '未找到同名符号定义';
  return matches.map((m) => `${m.path}:${m.line}: ${m.kind} ${m.name}`).join('\n');
}
