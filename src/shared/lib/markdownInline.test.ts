import { describe, expect, it } from 'vitest';
import { parseInlineMarkdown, stripInlineMarkdown } from './markdownInline';

describe('parseInlineMarkdown', () => {
  it('纯文本只出一个 token', () => {
    expect(parseInlineMarkdown('哈希表用空间换时间')).toEqual([
      { kind: 'text', text: '哈希表用空间换时间', start: 0 },
    ]);
  });

  it('加粗、行内代码、链接各自成 token', () => {
    expect(parseInlineMarkdown('用 **synchronized** 或 `ReentrantLock`')).toEqual([
      { kind: 'text', text: '用 ', start: 0 },
      { kind: 'bold', text: 'synchronized', start: 4 },
      { kind: 'text', text: ' 或 ', start: 18 },
      { kind: 'code', text: 'ReentrantLock', start: 22 },
    ]);
  });

  it('链接带上 href', () => {
    expect(parseInlineMarkdown('见 [文档](https://a.b/c) 说明')).toEqual([
      { kind: 'text', text: '见 ', start: 0 },
      { kind: 'link', text: '文档', start: 3, href: 'https://a.b/c' },
      { kind: 'text', text: ' 说明', start: 21 },
    ]);
  });

  it('斜体认单星号', () => {
    expect(parseInlineMarkdown('这是 *重点* 内容')[1]).toEqual({
      kind: 'italic',
      text: '重点',
      start: 4,
    });
  });

  it('snake_case 不会被当成斜体', () => {
    expect(parseInlineMarkdown('字段 user_name_id 不变')).toEqual([
      { kind: 'text', text: '字段 user_name_id 不变', start: 0 },
    ]);
  });

  it('孤立的星号与反引号原样留在正文里', () => {
    expect(stripInlineMarkdown('2 * 3 = 6 且 a `b')).toBe('2 * 3 = 6 且 a `b');
  });

  it('token 的 start 指回源串里的同一段文字', () => {
    const source = '前缀 **加粗** 后缀';
    for (const token of parseInlineMarkdown(source)) {
      expect(source.slice(token.start, token.start + token.text.length)).toBe(token.text);
    }
  });

  it('baseOffset 会累加进 start', () => {
    expect(parseInlineMarkdown('**x**', 100)[0]).toEqual({ kind: 'bold', text: 'x', start: 102 });
  });

  it('反斜杠转义的星号不开启加粗', () => {
    expect(parseInlineMarkdown('a\\**b').every((t) => t.kind === 'text')).toBe(true);
  });

  it('没有收尾标记时原样当正文', () => {
    expect(parseInlineMarkdown('**没收尾')).toEqual([
      { kind: 'text', text: '**没收尾', start: 0 },
    ]);
  });
});
