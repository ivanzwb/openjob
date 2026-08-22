import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  PairingPayload,
  SyncExchangeRequest,
  SyncExchangeResponse,
  SyncPairRequest,
  SyncPairResponse,
  SyncPingResponse,
} from '@shared/sync';
import { SYNC_VERSION_MISMATCH, type SyncErrorBody } from '@shared/version';
import { getCurrentVersion } from '../lib/appVersion';

/**
 * 桌面端因版本不一致拒绝了这一轮。
 *
 * 单独立一个类型，是为了让界面能换成「去升级」的提示而不是一行红字错误：
 * 这条不是网络抖动，重试一百次也不会好，得让用户知道去装新版。
 */
export class SyncVersionMismatchError extends Error {
  readonly desktopVersion: string | null;
  readonly mobileVersion: string;

  constructor(message: string, desktopVersion: string | null, mobileVersion: string) {
    super(message);
    this.name = 'SyncVersionMismatchError';
    this.desktopVersion = desktopVersion;
    this.mobileVersion = mobileVersion;
  }
}

/** 把桌面端的错误体翻成异常；版本不一致那种单独成型 */
async function throwResponseError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as SyncErrorBody | null;
  if (body?.code === SYNC_VERSION_MISMATCH) {
    throw new SyncVersionMismatchError(
      body.error,
      body.desktopVersion ?? null,
      getCurrentVersion(),
    );
  }
  throw new Error(body?.error ?? `${fallback} (${res.status})`);
}

function toBase64Url(bytes: Uint8Array): string {
  const bin = String.fromCharCode(...bytes);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmacSha256Base64Url(key: string, payload: string): string {
  const keyBytes = new TextEncoder().encode(key);
  const data = new TextEncoder().encode(payload);
  const mac = hmac(sha256, keyBytes, data);
  return toBase64Url(mac);
}

export function signRequest(
  sharedKey: string,
  deviceId: string,
  timestamp: number,
  method: string,
  path: string,
  body: string,
): string {
  const payload = `${deviceId}|${timestamp}|${method.toUpperCase()}|${path}|${body}`;
  return hmacSha256Base64Url(sharedKey, payload);
}

const NETWORK_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    const host = new URL(input).host;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`连接 ${host} 超时，请确认桌面端已启动配对`);
    }
    throw new Error(`无法连接到桌面端 ${host}（网络被拒绝或重置），请确认桌面端已打开并生成二维码`);
  } finally {
    clearTimeout(timer);
  }
}

async function signedFetch(
  baseUrl: string,
  sharedKey: string,
  deviceId: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? init.body : '';
  const timestamp = Date.now();
  const signature = signRequest(sharedKey, deviceId, timestamp, method, path, body);

  return fetchWithTimeout(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      'X-Timestamp': String(timestamp),
      'X-Signature': signature,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function pingDesktop(baseUrl: string): Promise<SyncPingResponse> {
  const res = await fetchWithTimeout(`${baseUrl}/sync/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientMs: Date.now(), appVersion: getCurrentVersion() }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as SyncPingResponse;
}

export async function pairWithDesktop(
  payload: PairingPayload,
  deviceId: string,
  displayName: string,
): Promise<SyncPairResponse> {
  const baseUrl = `http://${payload.host}:${payload.port}`;
  const body: SyncPairRequest = {
    code: payload.code,
    deviceId,
    displayName,
    platform: 'mobile',
    appVersion: getCurrentVersion(),
  };
  const res = await fetchWithTimeout(`${baseUrl}/sync/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwResponseError(res, '配对失败');
  return (await res.json()) as SyncPairResponse;
}

export async function exchangeWithDesktop(
  baseUrl: string,
  sharedKey: string,
  deviceId: string,
  sinceSeq: number,
  changes: SyncExchangeRequest['changes'],
  options?: { full?: boolean },
): Promise<SyncExchangeResponse> {
  const body: SyncExchangeRequest = {
    sinceSeq,
    changes,
    clientMs: Date.now(),
    full: options?.full,
    appVersion: getCurrentVersion(),
  };
  const payload = JSON.stringify(body);
  const res = await signedFetch(baseUrl, sharedKey, deviceId, '/sync/exchange', {
    method: 'POST',
    body: payload,
  });
  if (!res.ok) await throwResponseError(res, '同步失败');
  return (await res.json()) as SyncExchangeResponse;
}
