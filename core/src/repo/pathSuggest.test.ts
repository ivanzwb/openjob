import { describe, expect, it } from 'vitest';
import { formatPathSuggestions, suggestRepoPaths } from './pathSuggest';

const REPO = [
  'src/agent.ts',
  'src/lib/agent.ts',
  'src/lib/parse.ts',
  'packages/core/src/lib/agent.ts',
  'docs/README.md',
];

describe('suggestRepoPaths', () => {
  it('模型多给了前缀时，能找回真正的那条', () => {
    // 用户实际遇到的那条：apps/cli/... 整段是编的，仓库里只有 src/lib/agent.ts
    expect(suggestRepoPaths(REPO, 'apps/cli/src/lib/agent.ts')[0]).toBe('src/lib/agent.ts');
  });

  it('模型少给了前缀时也能找回', () => {
    expect(suggestRepoPaths(['packages/core/src/lib/agent.ts'], 'lib/agent.ts')).toEqual([
      'packages/core/src/lib/agent.ts',
    ]);
  });

  it('只差大小写的排在最前', () => {
    const out = suggestRepoPaths(['src/lib/Agent.ts', 'src/other/agent.ts'], 'src/lib/agent.ts');
    expect(out[0]).toBe('src/lib/Agent.ts');
  });

  it('同名不同目录的都给出来，短路径优先', () => {
    const out = suggestRepoPaths(REPO, 'whatever/agent.ts');
    expect(out).toEqual(['src/agent.ts', 'src/lib/agent.ts', 'packages/core/src/lib/agent.ts']);
  });

  it('毫不相干的路径不硬凑候选', () => {
    expect(suggestRepoPaths(REPO, 'server/handler.go')).toEqual([]);
  });

  it('反斜杠和 ./ 前缀先归一，不然 Windows 上的路径永远匹配不上', () => {
    expect(suggestRepoPaths(['src/lib/agent.ts'], './apps\\cli\\src\\lib\\agent.ts')).toEqual([
      'src/lib/agent.ts',
    ]);
  });

  it('候选去重并受 limit 限制', () => {
    const dup = ['src/a/agent.ts', 'src/a/agent.ts', 'src/b/agent.ts', 'src/c/agent.ts'];
    expect(suggestRepoPaths(dup, 'agent.ts', 2)).toEqual(['src/a/agent.ts', 'src/b/agent.ts']);
  });

  it('空路径不返回整个仓库', () => {
    expect(suggestRepoPaths(REPO, '')).toEqual([]);
    expect(suggestRepoPaths(REPO, '.')).toEqual([]);
  });
});

describe('formatPathSuggestions', () => {
  it('没有候选时不留下空标题', () => {
    expect(formatPathSuggestions([])).toBe('');
  });

  it('有候选时逐条列出', () => {
    expect(formatPathSuggestions(['a.ts', 'b.ts'])).toBe(
      '\n仓库里相近的真实路径：\n- a.ts\n- b.ts',
    );
  });
});
