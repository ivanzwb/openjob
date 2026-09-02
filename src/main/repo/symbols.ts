import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractSymbolNames, langForExt } from '@shared/repo/symbolScan';
import { astWasUsed, extractSymbolsAst } from './treeSitter';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', '.next', 'target', '__pycache__', '.venv', 'vendor',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.md',
]);

// 符号识别的模式和实现都在 shared：find_symbol 工具要用同一套，而手机端跑不了
// tree-sitter，只能走这条正则路径。两处各存一份迟早会走岔。
const extractSymbols = extractSymbolNames;

/**
 * 生成带符号骨架的 repo map。
 * 优先走 tree-sitter AST；语法文件缺失或语言不支持时降级到正则。
 */
export async function buildRepoMapAsync(repoRoot: string, maxFiles = 80): Promise<string> {
  const lines: string[] = ['# Repo Map', ''];
  let count = 0;
  let regexFallbacks = 0;

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
          let hits = await extractSymbolsAst(content, ext);
          if (!hits) {
            hits = extractSymbols(content, langForExt(ext) ?? 'typescript');
            regexFallbacks++;
          }
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

  const source = astWasUsed()
    ? regexFallbacks > 0
      ? `tree-sitter AST（${regexFallbacks} 个文件降级为正则）`
      : 'tree-sitter AST'
    : '正则提取（tree-sitter 语法文件不可用）';
  lines.splice(1, 0, `> 符号来源：${source}`);

  return lines.join('\n');
}

export { extractSymbols };
