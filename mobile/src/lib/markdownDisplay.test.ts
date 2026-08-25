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

  it('行内标记渲染成标签，可见字符仍逐个映射回原文', () => {
    const contentMd = '用 **synchronized** 或 `ReentrantLock`';
    const html = markdownToAnnotatedSelectionHtml(contentMd, [], '#fef08a');
    expect(html).toContain('<strong>synchronized</strong>');
    expect(html).toContain('<code>ReentrantLock</code>');
    const map = JSON.parse(
      html.match(/data-visible-map="([^"]+)"/)![1]!.replace(/&quot;/g, '"'),
    ) as number[];
    const visible = '用 synchronized 或 ReentrantLock';
    expect(map).toHaveLength(visible.length);
    map.forEach((mdIndex, i) => expect(contentMd[mdIndex]).toBe(visible[i]));
  });

  it('列表项的项目符号也占住映射位', () => {
    const contentMd = '- 查找是 **O(1)**';
    const html = markdownToAnnotatedSelectionHtml(contentMd, [], '#fef08a');
    expect(html).toContain('<p>• ');
    const map = JSON.parse(
      html.match(/data-visible-map="([^"]+)"/)![1]!.replace(/&quot;/g, '"'),
    ) as number[];
    expect(map).toHaveLength('• 查找是 O(1)'.length);
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

  it('标题、列表、引用与行内标记都出预览结构', () => {
    const html = markdownToDisplayHtml(
      '## 本质\n- **空间**换时间\n2. 见 [文档](https://a.b)\n> 注意 `null`',
    );
    expect(html).toContain('<h2>本质</h2>');
    expect(html).toContain('<p>• <strong>空间</strong>换时间</p>');
    expect(html).toContain('<p>2. 见 <a href="https://a.b">文档</a></p>');
    expect(html).toContain('<blockquote>注意 <code>null</code></blockquote>');
  });

  it('围栏代码块不做行内解析', () => {
    expect(markdownToDisplayHtml('```js\nconst a = "**x**";\n```')).toBe(
      '<pre><code class="lang-js">const a = &quot;**x**&quot;;</code></pre>',
    );
  });
});
