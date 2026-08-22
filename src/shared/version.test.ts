import { describe, expect, it } from 'vitest';
import { compareVersions, isSyncCompatible, normalizeVersion, versionMismatchMessage } from './version';

describe('normalizeVersion', () => {
  it('去掉 tag 的 v 前缀', () => {
    expect(normalizeVersion('v0.7.0')).toBe('0.7.0');
    expect(normalizeVersion('V0.7.0')).toBe('0.7.0');
    expect(normalizeVersion('  0.7.0  ')).toBe('0.7.0');
  });
});

describe('compareVersions', () => {
  it('按数值比而不是按字符串比', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
  });

  it('缺位按 0 补', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('预发布与构建后缀不参与比较', () => {
    expect(compareVersions('0.7.0-beta.1', '0.7.0')).toBe(0);
    expect(compareVersions('0.7.0+build.9', '0.7.0')).toBe(0);
  });
});

describe('isSyncCompatible', () => {
  it('完全相同才放行', () => {
    expect(isSyncCompatible('0.7.0', '0.7.0')).toBe(true);
    expect(isSyncCompatible('v0.7.0', '0.7.0')).toBe(true);
  });

  it('补丁号不同也不放行——带迁移的发布经常只抬补丁号', () => {
    expect(isSyncCompatible('0.7.1', '0.7.0')).toBe(false);
  });

  it('大版本或次版本不同不放行', () => {
    expect(isSyncCompatible('1.0.0', '0.7.0')).toBe(false);
    expect(isSyncCompatible('0.8.0', '0.7.0')).toBe(false);
  });

  it('谁新谁旧都拦：老桌面配新手机同样不放行', () => {
    expect(isSyncCompatible('0.6.0', '0.7.0')).toBe(false);
    expect(isSyncCompatible('0.7.0', '0.6.0')).toBe(false);
  });
});

describe('versionMismatchMessage', () => {
  it('指出该升级哪一端', () => {
    expect(versionMismatchMessage('0.7.0', '0.6.0')).toContain('请先升级手机端');
    expect(versionMismatchMessage('0.6.0', '0.7.0')).toContain('请先升级桌面端');
  });

  it('两个版本号都写进提示，用户才知道差在哪', () => {
    const msg = versionMismatchMessage('0.7.0', '0.6.0');
    expect(msg).toContain('v0.7.0');
    expect(msg).toContain('v0.6.0');
  });

  it('认不出对端版本时也给出可执行的指引', () => {
    const msg = versionMismatchMessage('0.7.0', null);
    expect(msg).toContain('版本过旧');
    expect(msg).toContain('v0.7.0');
  });

  it('都说明本次没有同步数据', () => {
    expect(versionMismatchMessage('0.7.0', '0.6.0')).toContain('不同步');
    expect(versionMismatchMessage('0.7.0', null)).toContain('不同步');
  });
});
