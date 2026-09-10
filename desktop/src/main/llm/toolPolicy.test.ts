import { describe, expect, it } from 'vitest';
import { decideToolKind } from './toolPolicy';

describe('decideToolKind', () => {
  it('源码问答必须拿到读代码的工具', () => {
    // 这条曾经是反的：指定 repoId 反而把工具全关了，模型一个文件都读不到
    expect(decideToolKind({ repoId: 'r1' })).toBe('code');
  });

  it('源码问答没开联网时照样能读代码', () => {
    expect(decideToolKind({ repoId: 'r1', allowWebSearch: false })).toBe('code');
  });

  it('调用方显式关闭时，源码问答也不给工具', () => {
    expect(decideToolKind({ repoId: 'r1', allowTools: false })).toBe('none');
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
