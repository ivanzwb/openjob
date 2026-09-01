import { describe, expect, it } from 'vitest';
import { toSimplified } from './simplify';

describe('toSimplified', () => {
  it('把繁体字转成简体（字符级）', () => {
    expect(toSimplified('語音識別現在是繁體字')).toBe('语音识别现在是繁体字');
  });

  it('技术名词按字级正确落简体', () => {
    // 「數據庫」字级 →「数据库」，不受方言词典干扰
    expect(toSimplified('數據庫設計與算法')).toBe('数据库设计与算法');
  });

  it('已简体的文本原样返回', () => {
    const text = '面试备考，考点诊断';
    expect(toSimplified(text)).toBe(text);
  });

  it('空串与纯标点安全返回', () => {
    expect(toSimplified('')).toBe('');
    expect(toSimplified('，。！？')).toBe('，。！？');
  });
});