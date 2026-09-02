import { describe, expect, it } from 'vitest';
import { extractSymbolNames, findSymbolsInFiles, formatSymbolMatches } from './symbolScan';

const TS = `import { x } from './x';

export function runAgent(input: string) {
  return callAgent(input);
}

export class AgentRunner {
  run() {}
}

// runAgent 在这行只是注释里提到
const other = runAgent;
`;

const PY = `class Agent:
    def run_agent(self):
        pass
`;

const FILES = [
  { path: 'src/lib/agent.ts', content: TS },
  { path: 'src/py/agent.py', content: PY },
  { path: 'docs/readme.md', content: '# runAgent 文档里也提到了' },
];

describe('findSymbolsInFiles', () => {
  it('找到的是定义处，不是调用点', () => {
    const hits = findSymbolsInFiles(FILES, 'runAgent');
    expect(hits[0]).toEqual({
      path: 'src/lib/agent.ts',
      name: 'runAgent',
      kind: 'fn',
      line: 3,
    });
    // 第 13 行的 `const other = runAgent;` 定义的是 other，不该因为提到 runAgent 就命中
    expect(hits.map((h) => h.name)).not.toContain('other');
  });

  it('完全同名排在前缀/子串匹配前面', () => {
    const hits = findSymbolsInFiles(
      [{ path: 'a.ts', content: 'export function agentRunnerHelper() {}\nexport function agent() {}' }],
      'agent',
    );
    expect(hits.map((h) => h.name)).toEqual(['agent', 'agentRunnerHelper']);
  });

  it('大小写不敏感', () => {
    expect(findSymbolsInFiles(FILES, 'AGENTRUNNER')[0]?.name).toBe('AgentRunner');
  });

  it('按语言用各自的模式，认得 python 的 def / class', () => {
    const hits = findSymbolsInFiles(FILES, 'run_agent');
    expect(hits[0]).toMatchObject({ path: 'src/py/agent.py', name: 'run_agent', line: 2 });
  });

  it('不认识的扩展名直接跳过，不拿 markdown 里的文字当符号', () => {
    const hits = findSymbolsInFiles(FILES, 'runAgent');
    expect(hits.every((h) => !h.path.endsWith('.md'))).toBe(true);
  });

  it('空查询不返回整个仓库的符号', () => {
    expect(findSymbolsInFiles(FILES, '')).toEqual([]);
    expect(findSymbolsInFiles(FILES, '   ')).toEqual([]);
  });

  it('受 limit 限制', () => {
    const many = { path: 'm.ts', content: Array.from({ length: 50 }, (_, i) => `export function agent${i}() {}`).join('\n') };
    expect(findSymbolsInFiles([many], 'agent', 5)).toHaveLength(5);
  });

  it('接受惰性生成器，桌面端不必先把整仓读进内存', () => {
    function* lazy() {
      yield { path: 'src/lib/agent.ts', content: TS };
    }
    expect(findSymbolsInFiles(lazy(), 'AgentRunner')[0]?.kind).toBe('class');
  });
});

describe('extractSymbolNames', () => {
  it('按顺序列出文件里的符号骨架', () => {
    const hits = extractSymbolNames(TS, 'typescript');
    expect(hits.map((h) => h.name)).toEqual(['runAgent', 'AgentRunner', 'other']);
  });

  it('受 limit 限制，repo map 靠它控制体积', () => {
    expect(extractSymbolNames(TS, 'typescript', 1)).toHaveLength(1);
  });
});

describe('formatSymbolMatches', () => {
  it('没命中时给一句明确的话，而不是空字符串', () => {
    expect(formatSymbolMatches([])).toBe('未找到同名符号定义');
  });

  it('输出 path:line 格式，模型可以直接拿去 read_file', () => {
    expect(formatSymbolMatches([{ path: 'a.ts', name: 'f', kind: 'fn', line: 7 }])).toBe(
      'a.ts:7: fn f',
    );
  });
});
