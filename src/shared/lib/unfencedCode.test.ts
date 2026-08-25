import { describe, expect, it } from 'vitest';
import { findUnfencedCodeRunEnd, isStrongCodeLine } from './unfencedCode';

function runOf(text: string): string[] | null {
  const lines = text.split('\n');
  const end = findUnfencedCodeRunEnd(lines, 0);
  return end === null ? null : lines.slice(0, end);
}

describe('unfencedCode 真阳性', () => {
  it('大括号语言：分号与括号行', () => {
    expect(runOf('int sum = 0;\nfor (int i = 0; i < n; i++) {\n  sum += a[i];\n}')).toEqual([
      'int sum = 0;',
      'for (int i = 0; i < n; i++) {',
      '  sum += a[i];',
      '}',
    ]);
  });

  it('Python：def / 冒号结尾 / 整行调用', () => {
    expect(runOf('def solve(nums):\n    total = 0\n    print(total)')).toEqual([
      'def solve(nums):',
      '    total = 0',
      '    print(total)',
    ]);
  });

  it('缩进的中文注释不会把代码段劈开', () => {
    expect(runOf('def solve(nums):\n    # 双指针，左右各扫一遍\n    left = 0\n    return left')).toEqual([
      'def solve(nums):',
      '    # 双指针，左右各扫一遍',
      '    left = 0',
      '    return left',
    ]);
  });

  it('箭头函数与 import', () => {
    expect(runOf("import fs from 'fs';\nconst read = (p) => fs.readFileSync(p);")).toHaveLength(2);
  });

  it('代码段内允许一个空行', () => {
    expect(runOf('const a = 1;\n\nconst b = 2;')).toEqual(['const a = 1;', '', 'const b = 2;']);
  });

  it('连续两个空行就断开，且不吃进尾部空行', () => {
    expect(runOf('const a = 1;\nconst b = 2;\n\n\n这是后面的说明')).toEqual([
      'const a = 1;',
      'const b = 2;',
    ]);
  });

  it('遇到正文就停下，不把中文说明卷进代码块', () => {
    expect(runOf('const a = 1;\nconst b = 2;\n这样就完成了初始化。')).toEqual([
      'const a = 1;',
      'const b = 2;',
    ]);
  });
});

describe('unfencedCode 真阴性', () => {
  it('中文正文', () => {
    expect(runOf('哈希表的查找是 O(1)。\n代价是额外的内存开销。\n面试常问冲突怎么解决。')).toBeNull();
  });

  it('中文正文里出现 => 也不算代码', () => {
    expect(runOf('请求链路是 网关 => 服务 => 数据库。\n每一跳都要考虑超时。')).toBeNull();
  });

  it('markdown 表格', () => {
    expect(runOf('| 指标 | 说明 |\n| --- | --- |\n| MRR | 排序质量 |')).toBeNull();
  });

  it('markdown 列表', () => {
    expect(runOf('- const 声明的变量不能重新赋值\n- let 可以\n- var 有变量提升')).toBeNull();
  });

  it('缩进的嵌套列表', () => {
    expect(runOf('- 方案 A\n    - 优点：快\n    - 缺点：贵')).toBeNull();
  });

  it('markdown 标题', () => {
    expect(runOf('## 一句话本质\n### 面试真实问法')).toBeNull();
  });

  it('引用块', () => {
    expect(runOf('> 注意线程安全\n> 否则会有竞态')).toBeNull();
  });

  it('只有一行代码不成块', () => {
    expect(runOf('return true;\n这一行就够了。')).toBeNull();
  });

  it('只靠缩进凑不出代码块', () => {
    expect(runOf('    这是一段缩进的说明文字\n    还有第二行说明文字')).toBeNull();
  });

  it('中文的「变量 = 数值」不当赋值', () => {
    expect(runOf('准确率 = 0.95\n召回率 = 0.88')).toBeNull();
  });
});

describe('isStrongCodeLine', () => {
  it.each([
    'const a = 1;',
    'function foo() {',
    '}',
    '#include <stdio.h>',
    'return x + y;',
    'console.log(x)',
    '<div class="a">',
    'public class Solution {',
  ])('命中：%s', (line) => {
    expect(isStrongCodeLine(line)).toBe(true);
  });

  it.each([
    '这是一句中文说明。',
    '- 列表项',
    '## 标题',
    '| a | b |',
    '时间复杂度是 O(n)',
    '',
  ])('不命中：%s', (line) => {
    expect(isStrongCodeLine(line)).toBe(false);
  });
});
