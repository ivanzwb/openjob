import { describe, expect, it } from 'vitest';
import { markerBadgeLabel, resolveInlineAnnotationIndex } from './inlineMarkers';

describe('inline annotation markers', () => {
  it('笔记和细化使用与手机端一致的紧凑标签', () => {
    expect(markerBadgeLabel([{ kind: 'note' }])).toBe('笔');
    expect(markerBadgeLabel([{ kind: 'elaboration' }])).toBe('细');
    expect(markerBadgeLabel([{ kind: 'note' }, { kind: 'elaboration' }])).toBe('笔/细');
  });

  it('重复文本按保存的 selectionStart 定位到正确一处', () => {
    const text = '第一次加锁，然后第二次加锁';
    const second = text.lastIndexOf('加锁');
    expect(resolveInlineAnnotationIndex(text, 100, '加锁', 100 + second)).toEqual({
      index: second,
      needle: '加锁',
    });
  });

  it('旧标记没有 selectionStart 时兼容定位到首个匹配', () => {
    expect(resolveInlineAnnotationIndex('先检查再检查', 0, '检查')).toEqual({
      index: 1,
      needle: '检查',
    });
  });
});
