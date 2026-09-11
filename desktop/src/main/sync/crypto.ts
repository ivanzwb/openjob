import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;

export function generateSharedKey(): string {
  return randomBytes(32).toString('base64url');
}

export function generatePairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 请求签名：HMAC-SHA256(deviceId|timestamp|method|path|body) */
export function signRequest(
  sharedKey: string,
  deviceId: string,
  timestamp: number,
  method: string,
  path: string,
  body: string,
): string {
  const payload = `${deviceId}|${timestamp}|${method.toUpperCase()}|${path}|${body}`;
  return createHmac('sha256', sharedKey).update(payload).digest('base64url');
}

export function verifyRequest(
  sharedKey: string,
  deviceId: string,
  timestamp: number,
  method: string,
  path: string,
  body: string,
  signature: string,
): boolean {
  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_SKEW_MS) return false;

  const expected = signRequest(sharedKey, deviceId, timestamp, method, path, body);
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
