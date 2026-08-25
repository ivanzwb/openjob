import { describe, expect, it } from 'vitest';
import { markdownToAnnotatedSelectionHtml, markdownToDisplayHtml } from './markdownDisplay';

describe('markdownToAnnotatedSelectionHtml', () => {
  it('maps visible heading text back to contentMd offsets', () => {
    const contentMd = '## Hello world';
    const html = markdownToAnnotatedSelectionHtml(contentMd, [], '#fef08a');
    expect(html).toContain('data-md-start="0"');
    expect(html).toContain('<h2>Hello world</h2>');
    const mapMatch = html.match(/data-visible-map="([^"]+)"/);
    expect(mapMatch).not.toBeNull();
    const map = JSON.parse(mapMatch![1]!.replace(/&quot;/g, '"')) as number[];
    expect(map[0]).toBe(3);
    expect(map[map.length - 1]).toBe(contentMd.length - 1);
  });

  it('injects highlight spans at source offsets', () => {
    const contentMd = '**bold** text';
    const html = markdownToAnnotatedSelectionHtml(
      contentMd,
      [
        {
          id: 'a1',
          targetType: 'explanation',
          targetId: 'e1',
          kind: 'highlight',
          selectedText: 'bold',
          noteMd: null,
          selectionStart: 2,
          highlightColor: '#fef08a',
          createdAt: 0,
        },
      ],
      '#fef08a',
    );
    expect(html).toContain('class="highlight-mark"');
    expect(html).toContain('bold');
    expect(html).not.toContain('**');
  });

  it('无围栏代码进 pre，且偏移映射仍指向原文', () => {
    const contentMd = 'const a = 1;\nconst b = 2;';
    const html = markdownToAnnotatedSelectionHtml(contentMd, [], '#fef08a');
    expect(html).toContain('<pre><code>');
    const mapMatch = html.match(/data-visible-map="([^"]+)"/);
    const map = JSON.parse(mapMatch![1]!.replace(/&quot;/g, '"')) as number[];
    expect(map[0]).toBe(0);
    expect(map[map.length - 1]).toBe(contentMd.length - 1);
  });
});

describe('markdownToDisplayHtml', () => {
  it('无围栏代码渲染成 pre', () => {
    expect(markdownToDisplayHtml('def solve(n):\n    return n + 1')).toBe(
      '<pre><code>def solve(n):\n    return n + 1</code></pre>',
    );
  });

  it('中文正文不会被当成代码', () => {
    const html = markdownToDisplayHtml('哈希表用空间换时间。\n冲突用链地址法解决。');
    expect(html).not.toContain('<pre>');
  });
});
