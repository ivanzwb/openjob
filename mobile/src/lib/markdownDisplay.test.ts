import { describe, expect, it } from 'vitest';
import { markdownToAnnotatedSelectionHtml } from './markdownDisplay';

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
});
