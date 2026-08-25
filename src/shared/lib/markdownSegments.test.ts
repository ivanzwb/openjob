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
});
