import { describe, expect, it } from 'vitest';
import {
  parseMarkdownLine,
  parseMarkdownTextSegments,
  splitMarkdownTableCells,
} from './markdownSegments';

describe('parseMarkdownLine', () => {
  it('标题带出层级与正文起点', () => {
    expect(parseMarkdownLine('## 一句话本质')).toEqual({
      kind: 'heading',
      level: 2,
      text: '一句话本质',
      contentStart: 3,
    });
  });

  it('无序与有序列表', () => {
    expect(parseMarkdownLine('- 查找 O(1)')).toMatchObject({ kind: 'bullet', contentStart: 2 });
    expect(parseMarkdownLine('12. 第十二点')).toMatchObject({
      kind: 'numbered',
      text: '第十二点',
      contentStart: 4,
    });
  });

  it('引用块', () => {
    expect(parseMarkdownLine('> 注意线程安全')).toMatchObject({ kind: 'quote', contentStart: 2 });
  });

  it('普通行只剥缩进', () => {
    expect(parseMarkdownLine('  正文一句话')).toEqual({
      kind: 'plain',
      level: 0,
      text: '正文一句话',
      contentStart: 2,
    });
  });

  it('contentStart 指回原行里的同一段文字', () => {
    for (const line of ['### 标题', '  - 项目', '3) 第三点', '> 引用', '正文']) {
      const parsed = parseMarkdownLine(line);
      expect(line.slice(parsed.contentStart)).toBe(parsed.text);
    }
  });

  it('不把 #tag 或裸减号当成结构行', () => {
    expect(parseMarkdownLine('#hashtag 不是标题')).toMatchObject({ kind: 'plain' });
    expect(parseMarkdownLine('-1 是负数')).toMatchObject({ kind: 'plain' });
  });
});

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
