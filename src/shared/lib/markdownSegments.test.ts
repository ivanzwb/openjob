import { describe, expect, it } from 'vitest';
import { parseMarkdownTextSegments, splitMarkdownTableCells } from './markdownSegments';

describe('markdownSegments', () => {
  it('splitMarkdownTableCells 保留空列', () => {
    expect(splitMarkdownTableCells('| A |  | C |')).toEqual(['A', '', 'C']);
  });

  it('段落与表格混排', () => {
    const segments = parseMarkdownTextSegments(
      '标题\n\n| 指标 | 说明 |\n| --- | --- |\n| MRR | 排序质量 |',
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: 'paragraph' });
    expect(segments[1]).toEqual({
      type: 'table',
      rows: [
        ['指标', '说明'],
        ['MRR', '排序质量'],
      ],
    });
  });

  it('不把列表里带 | 的行当成表格', () => {
    const segments = parseMarkdownTextSegments('- 对比 A | B 两种方案');
    expect(segments).toEqual([{ type: 'paragraph', lines: ['- 对比 A | B 两种方案'] }]);
  });

  it('漏了围栏的代码切成 code 段，前后正文各自成段', () => {
    const segments = parseMarkdownTextSegments(
      '看下面这段：\nconst a = 1;\nconst b = a + 1;\n这样就拿到结果了。',
    );
    expect(segments).toEqual([
      { type: 'paragraph', lines: ['看下面这段：'] },
      { type: 'code', lines: ['const a = 1;', 'const b = a + 1;'] },
      { type: 'paragraph', lines: ['这样就拿到结果了。'] },
    ]);
  });

  it('中文正文、列表、标题、表格都不会被当成代码', () => {
    const segments = parseMarkdownTextSegments(
      '## 一句话本质\n哈希表用空间换时间。\n- 查找 O(1)\n- 冲突要处理\n\n| 指标 | 说明 |\n| --- | --- |\n| MRR | 排序质量 |',
    );
    expect(segments.some((seg) => seg.type === 'code')).toBe(false);
  });
});
