import { describe, expect, it } from 'vitest';
import { markdownToPlainText, visibleMarkdownBlocks } from './markdownBlocks';

describe('visibleMarkdownBlocks', () => {
  it('纯文本 -> 单个 text 块', () => {
    expect(visibleMarkdownBlocks('hello world')).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('空字符串 -> 空数组（开头空白被去掉且无内容）', () => {
    expect(visibleMarkdownBlocks('')).toEqual([]);
  });

  it('只有空白 -> 空数组', () => {
    expect(visibleMarkdownBlocks('   \n  ')).toEqual([]);
  });

  it('mermaid 代码块 -> mermaid 块（body 保留尾部换行）', () => {
    const blocks = visibleMarkdownBlocks('```mermaid\ngraph TD\nA-->B\n```');
    expect(blocks).toEqual([{ type: 'mermaid', value: 'graph TD\nA-->B\n' }]);
  });

  it('带语言的代码块 -> code 块带 lang', () => {
    const blocks = visibleMarkdownBlocks('```ts\nconst x = 1;\n```');
    expect(blocks).toEqual([{ type: 'code', value: 'const x = 1;\n', lang: 'ts' }]);
  });

  it('无语言代码块 -> code 块不带 lang', () => {
    const blocks = visibleMarkdownBlocks('```\nplain\n```');
    expect(blocks).toEqual([{ type: 'code', value: 'plain\n' }]);
  });

  it('文本与代码块混排 -> 按序切块', () => {
    const blocks = visibleMarkdownBlocks('开头文字\n```js\ncode\n```\n结尾文字');
    expect(blocks.map((b) => b.type)).toEqual(['text', 'code', 'text']);
    expect(blocks[1]).toMatchObject({ type: 'code', lang: 'js' });
  });

  it('空块被过滤（连续围栏之间的空隙不产生 text 块）', () => {
    const blocks = visibleMarkdownBlocks('```a\nx\n```\n\n```b\ny\n```');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === 'code')).toBe(true);
  });

  it('去掉开头空白避免角标与正文之间出现大段空行', () => {
    const blocks = visibleMarkdownBlocks('\n\n\n# 标题');
    expect(blocks[0]).toEqual({ type: 'text', value: '# 标题' });
  });
});

describe('markdownToPlainText', () => {
  it('纯文本原样返回', () => {
    expect(markdownToPlainText('hello')).toBe('hello');
  });

  it('mermaid 块转成 [流程图] 占位', () => {
    expect(markdownToPlainText('```mermaid\ngraph TD\nA\n```')).toBe('[流程图]\ngraph TD\nA');
  });

  it('代码块保留围栏与语言标注', () => {
    expect(markdownToPlainText('```ts\nconst x = 1;\n```')).toBe('```ts\nconst x = 1;\n```');
  });

  it('多块按空行拼接', () => {
    expect(markdownToPlainText('a\n```ts\nb\n```')).toBe('a\n\n\n```ts\nb\n```');
  });
});