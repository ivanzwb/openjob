/**
 * 守「一段里的行合到同一个 Text」这条线。
 *
 * RN 里选取范围盖不过兄弟 Text，所以这个分组直接决定了用户一次能选多少字。
 * 原来是一行一个 Text，长按只能选中一行，跨行就断——用户报的「跨了段就选取
 * 不了」就是从这儿来的。用例盯的是「连续的行必须落在同一个 run 里」，退回
 * 一行一个 run 时要立刻失败。
 */
import { describe, expect, it } from 'vitest';
import { groupParagraphRuns } from './markdownRuns';

describe('段落分组', () => {
  it('连续的普通行合成一个 run', () => {
    const runs = groupParagraphRuns(['第一段。', '第二段。', '第三段。']);

    expect(runs).toEqual([
      { kind: 'lines', lines: ['第一段。', '第二段。', '第三段。'] },
    ]);
  });

  it('标题、项目符号、有序列表和正文混排也是一个 run', () => {
    // 这几种行的差异只体现在字号和行首标记上，都能靠嵌套 Text 表达，
    // 没有理由为它们把选取范围切断
    const runs = groupParagraphRuns([
      '## 幂等消费',
      '先说结论。',
      '- 唯一键去重',
      '1. 先查后写',
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      kind: 'lines',
      lines: ['## 幂等消费', '先说结论。', '- 唯一键去重', '1. 先查后写'],
    });
  });

  it('引用行自己一个 run，前后的正文各自合并', () => {
    const runs = groupParagraphRuns(['前面一句。', '> 引用的话', '后面一句。', '再一句。']);

    expect(runs).toEqual([
      { kind: 'lines', lines: ['前面一句。'] },
      { kind: 'quote', line: '> 引用的话' },
      { kind: 'lines', lines: ['后面一句。', '再一句。'] },
    ]);
  });

  it('连续的引用行不会被合并——每道竖线都得是独立的 Text', () => {
    const runs = groupParagraphRuns(['> 第一句', '> 第二句']);

    expect(runs).toEqual([
      { kind: 'quote', line: '> 第一句' },
      { kind: 'quote', line: '> 第二句' },
    ]);
  });

  it('没有行就没有 run', () => {
    expect(groupParagraphRuns([])).toEqual([]);
  });
});
