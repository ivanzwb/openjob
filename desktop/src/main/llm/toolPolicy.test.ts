import { describe, expect, it } from 'vitest';
import { decideToolKind } from './toolPolicy';

describe('decideToolKind', () => {
  it('调用方显式关闭时不给任何工具', () => {
    expect(decideToolKind({ allowTools: false })).toBe('none');
  });

  it('考点追问默认不带工具', () => {
    expect(decideToolKind({ sessionKind: 'nodeFollowUp' })).toBe('none');
  });

  it('考点追问显式开启后照常给', () => {
    expect(
      decideToolKind({ sessionKind: 'nodeFollowUp', allowTools: true, allowWebSearch: true }),
    ).toBe('web');
  });

  it('开了联网走联网工具集', () => {
    expect(decideToolKind({ allowWebSearch: true })).toBe('web');
  });

  it('没开联网但规则判定这题必须搜，也走联网', () => {
    expect(decideToolKind({}, true)).toBe('web');
  });

  it('不联网但挂着 campaign 时，只给知识图谱', () => {
    expect(decideToolKind({ campaignId: 'c1' })).toBe('graph');
  });

  it('不联网又没有 campaign 时确实没有可用工具', () => {
    expect(decideToolKind({})).toBe('none');
    expect(decideToolKind({ campaignId: null })).toBe('none');
  });
});
