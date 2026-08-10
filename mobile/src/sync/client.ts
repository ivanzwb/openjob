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
    body: JSON.stringify({ clientMs: Date.now() }),
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
  };
  const res = await fetchWithTimeout(`${baseUrl}/sync/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `配对失败 (${res.status})`);
  }
  return (await res.json()) as SyncPairResponse;
}

export async function exchangeWithDesktop(
  baseUrl: string,
  sharedKey: string,
  deviceId: string,
  sinceSeq: number,
  changes: SyncExchangeRequest['changes'],
): Promise<SyncExchangeResponse> {
  const body: SyncExchangeRequest = {
    sinceSeq,
    changes,
    clientMs: Date.now(),
  };
  const payload = JSON.stringify(body);
  const res = await signedFetch(baseUrl, sharedKey, deviceId, '/sync/exchange', {
    method: 'POST',
    body: payload,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `同步失败 (${res.status})`);
  }
  return (await res.json()) as SyncExchangeResponse;
}
