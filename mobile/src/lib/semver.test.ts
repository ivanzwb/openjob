import { describe, expect, it } from 'vitest';
import { compareVersions, normalizeVersion } from './semver';

describe('normalizeVersion', () => {
  it('去掉 v 前缀', () => {
    expect(normalizeVersion('v0.3.0')).toBe('0.3.0');
    expect(normalizeVersion('V0.3.0')).toBe('0.3.0');
  });

  it('无前缀原样返回', () => {
    expect(normalizeVersion('0.3.0')).toBe('0.3.0');
  });

  it('去除首尾空白', () => {
    expect(normalizeVersion('  v0.3.0  ')).toBe('0.3.0');
  });
});

describe('compareVersions', () => {
  it('数值比较而非字符串比较：0.10.0 大于 0.9.0', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('相同版本返回 0', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    // v 前缀与纯版本号视为同一个
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
  });

  it('新版本返回 1', () => {
    expect(compareVersions('0.5.0', '0.4.0')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });

  it('旧版本返回 -1', () => {
    expect(compareVersions('0.4.0', '0.5.0')).toBe(-1);
  });

  it('段数不同时缺位按 0 补：1.2 等于 1.2.0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('预发布后缀不参与比较', () => {
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0-beta.2')).toBe(0);
  });

  it('构建元数据不参与比较', () => {
    expect(compareVersions('0.3.0+build.5', '0.3.0')).toBe(0);
  });

  it('非数字段按 0 处理', () => {
    expect(compareVersions('0.a.0', '0.0.0')).toBe(0);
  });
});