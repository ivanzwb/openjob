import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', '.next', 'target', '__pycache__', '.venv', 'vendor',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.md',
]);

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.swift': 'swift',
};

interface SymbolHit {
  name: string;
  kind: string;
  line: number;
}

const PATTERNS: Record<string, RegExp[]> = {
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

function extractSymbols(content: string, lang: string): SymbolHit[] {
  const patterns = PATTERNS[lang] ?? PATTERNS.typescript ?? [];
  const lines = content.split(/\r?\n/);
  const hits: SymbolHit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    for (const re of patterns) {
      const m = line.match(re);
      if (m?.[1]) {
        hits.push({
          name: m[1],
          kind: line.includes('class') ? 'class' : line.includes('interface') ? 'interface' : 'fn',
          line: i + 1,
        });
        break;
      }
    }
    if (hits.length >= 30) break;
  }
  return hits;
}

/** 生成带符号骨架的 repo map（正则提取函数/类/接口，优于仅列目录） */
export async function buildRepoMapAsync(repoRoot: string, maxFiles = 80): Promise<string> {
  const lines: string[] = ['# Repo Map', ''];
  let count = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
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
        await walk(full, depth + 1);
      } else {
        const ext = e.name.slice(e.name.lastIndexOf('.'));
        if (!TEXT_EXT.has(ext)) continue;
        try {
          if (statSync(full).size > 200_000) continue;
        } catch {
          continue;
        }

        lines.push(`${indent}${e.name}`);
        count++;

        try {
          const content = readFileSync(full, 'utf8');
          const lang = EXT_LANG[ext] ?? 'typescript';
          const hits = extractSymbols(content, lang);
          for (const h of hits.slice(0, 12)) {
            lines.push(`${indent}  - ${h.kind} ${h.name} :${h.line}`);
          }
        } catch {
          // 跳过无法解析的文件
        }
      }
    }
  };

  await walk(repoRoot, 0);
  if (lines.length <= 2) {
    const { buildRepoMap } = await import('./files');
    return buildRepoMap(repoRoot, maxFiles);
  }
  return lines.join('\n');
}

export { extractSymbols };
