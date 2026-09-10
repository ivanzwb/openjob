import { describe, expect, it } from 'vitest';
import { globFromPaths, globToRegExp } from './virtualFs';

const REPO = [
  'agent.ts',
  'src/agent.ts',
  'src/lib/agent.ts',
  'src/lib/parse.ts',
  'packages/core/src/lib/agent.ts',
  'docs/agent.md',
];

describe('globFromPaths', () => {
  it('只给文件名时在任意目录下找，短路径优先', () => {
    // 模型最常问的就是「agent.ts 在哪」，这条缺失时它只会去编路径
    expect(globFromPaths(REPO, 'agent.ts')).toEqual([
      'agent.ts',
      'src/agent.ts',
      'src/lib/agent.ts',
      'packages/core/src/lib/agent.ts',
    ]);
  });

  it('**/ 跨任意层目录，也包含零层', () => {
    expect(globFromPaths(['a.ts', 'x/a.ts', 'x/y/a.ts'], '**/a.ts')).toEqual([
      'a.ts',
      'x/a.ts',
      'x/y/a.ts',
    ]);
  });

  it('* 不跨目录分隔符', () => {
    expect(globFromPaths(REPO, '*.ts')).toEqual(['agent.ts']);
  });

  it('带目录前缀的 glob 只在该子树里找', () => {
    expect(globFromPaths(REPO, 'src/**/*.ts')).toEqual([
      'src/agent.ts',
      'src/lib/agent.ts',
      'src/lib/parse.ts',
    ]);
  });

  it('大小写不敏感：模型给的大小写常常是错的', () => {
    expect(globFromPaths(['src/lib/Agent.ts'], 'agent.ts')).toEqual(['src/lib/Agent.ts']);
  });

  it('反斜杠路径和模式都先归一', () => {
    expect(globFromPaths(['src\\lib\\agent.ts'], 'src\\lib\\*.ts')).toEqual(['src/lib/agent.ts']);
  });

  it('? 只匹配一个字符且不跨目录', () => {
    expect(globFromPaths(['a1.ts', 'a12.ts', 'x/a1.ts'], 'a?.ts')).toEqual(['a1.ts']);
  });

  it('没命中就是空，不退化成返回全部', () => {
    expect(globFromPaths(REPO, 'nope.go')).toEqual([]);
    expect(globFromPaths(REPO, '')).toEqual([]);
    expect(globFromPaths(REPO, '.')).toEqual([]);
  });

  it('结果去重并受 limit 限制', () => {
    expect(globFromPaths(['x/a.ts', 'x/a.ts', 'y/a.ts'], 'a.ts', 1)).toEqual(['x/a.ts']);
  });
});

describe('globToRegExp', () => {
  it('点号按字面匹配，不当成任意字符', () => {
    const re = globToRegExp('a.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('axts')).toBe(false);
  });

  it('整体锚定，不做子串匹配', () => {
    const re = globToRegExp('src/a.ts');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('other/src/a.ts')).toBe(false);
  });
});
