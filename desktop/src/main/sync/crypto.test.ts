import { describe, expect, it, vi } from 'vitest';
import { generatePairingCode, generateSharedKey, signRequest, verifyRequest } from './crypto';

describe('generateSharedKey', () => {
  it('生成 32 字节 base64url 密钥', () => {
    const key = generateSharedKey();
    expect(key.length).toBeGreaterThan(40); // 32 bytes -> 43 chars base64url
    expect(generateSharedKey()).not.toBe(key);
  });
});

describe('signRequest / verifyRequest', () => {
  const key = 'test-shared-key-0123456789abcdef';
  const body = JSON.stringify({ a: 1 });

  it('合法签名通过校验', () => {
    const ts = Date.now();
    const sig = signRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body);
    expect(verifyRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body, sig)).toBe(true);
  });

  it('签名对 method 大小写不敏感（签的是大写后的值）', () => {
    const ts = Date.now();
    const sig = signRequest(key, 'deviceA', ts, 'post', '/sync/pull', body);
    expect(verifyRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body, sig)).toBe(true);
  });

  it('篡改 body -> 校验失败', () => {
    const ts = Date.now();
    const sig = signRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body);
    expect(verifyRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body + 'x', sig)).toBe(false);
  });

  it('换设备 ID -> 校验失败', () => {
    const ts = Date.now();
    const sig = signRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body);
    expect(verifyRequest(key, 'deviceB', ts, 'POST', '/sync/pull', body, sig)).toBe(false);
  });

  it('换密钥 -> 校验失败', () => {
    const ts = Date.now();
    const sig = signRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body);
    expect(verifyRequest('wrong-key', 'deviceA', ts, 'POST', '/sync/pull', body, sig)).toBe(false);
  });

  it('时间戳超出 ±5 分钟窗口 -> 校验失败（防重放）', () => {
    const now = Date.now();
    const sig = signRequest(key, 'deviceA', now, 'POST', '/sync/pull', body);
    expect(verifyRequest(key, 'deviceA', now - 6 * 60 * 1000, 'POST', '/sync/pull', body, sig)).toBe(false);
    expect(verifyRequest(key, 'deviceA', now + 6 * 60 * 1000, 'POST', '/sync/pull', body, sig)).toBe(false);
  });

  it('窗口内的时间戳通过校验', () => {
    const now = Date.now();
    const sig = signRequest(key, 'deviceA', now - 4 * 60 * 1000, 'POST', '/sync/pull', body);
    expect(verifyRequest(key, 'deviceA', now - 4 * 60 * 1000, 'POST', '/sync/pull', body, sig)).toBe(true);
  });

  it('畸形签名 -> 校验失败而非抛异常', () => {
    const ts = Date.now();
    expect(verifyRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body, 'not-base64!')).toBe(false);
    expect(verifyRequest(key, 'deviceA', ts, 'POST', '/sync/pull', body, '')).toBe(false);
  });
});

describe('generatePairingCode', () => {
  it('生成 6 位数字码', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // 100000 + 0.5 * 900000 = 550000
    expect(generatePairingCode()).toBe('550000');
    vi.restoreAllMocks();
  });

  it('多次生成落在 100000-999999', () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
      expect(Number(code)).toBeLessThanOrEqual(999999);
    }
  });
});