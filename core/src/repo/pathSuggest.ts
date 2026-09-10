/**
 * 模型很容易编出「看着合理但仓库里没有」的路径，monorepo 下猜错前缀尤其常见
 * （把 src/lib/agent.ts 说成 apps/cli/src/lib/agent.ts）。读不到时只回一句
 * 「不存在」，模型无从纠正、用户也无从判断，所以顺手给几条真实存在的相近路径。
 */

import { normalizeRepoPath } from './virtualFs';

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** 分数越高越像用户/模型想找的那个，同分时短路径优先 */
function score(candidate: string, target: string): number {
  if (candidate === target) return 3; // 走到这儿说明按原样打不开，那就是只差大小写
  if (candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`)) return 2; // 前缀多给或少给了几层
  if (baseName(candidate) === baseName(target)) return 1; // 同名不同目录
  return 0;
}

export function suggestRepoPaths(knownPaths: string[], missing: string, limit = 5): string[] {
  const target = normalizeRepoPath(missing).toLowerCase();
  if (!target || target === '.') return [];

  const seen = new Set<string>();
  const hits: Array<{ path: string; score: number }> = [];
  for (const raw of knownPaths) {
    const path = normalizeRepoPath(raw);
    if (seen.has(path)) continue;
    seen.add(path);
    const s = score(path.toLowerCase(), target);
    if (s > 0) hits.push({ path, score: s });
  }

  hits.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return hits.slice(0, limit).map((h) => h.path);
}

/** 拼成可直接接在「文件不存在」后面的一段；没有候选时返回空串 */
export function formatPathSuggestions(suggestions: string[]): string {
  if (suggestions.length === 0) return '';
  return `\n仓库里相近的真实路径：\n${suggestions.map((p) => `- ${p}`).join('\n')}`;
}
