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

/** 握手超时。ping / pair 只交换几十字节，慢过这个数就是网络本身不通 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 一轮 exchange 的超时。
 *
 * 不能和握手共用一个数：exchange 要等桌面端把本轮变更全部应用完、再把回包整个
 * 序列化出来，全表对账时还带着源码快照，十秒根本不够。
 *
 * 更要紧的是这种超时会自我维持，给小了不是偶尔失败而是再也不会成功：手机端一旦
 * 掐断，水位线就不推进，桌面端下一轮还是从同一个起点重算同一份回包，而它的 oplog
 * 还在往前走，回包只会一轮比一轮大。0.6.8 就是这么卡死的。
 */
const EXCHANGE_TIMEOUT_MS = 180_000;

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    const host = new URL(input).host;
    // 判断是不是自己掐的要看 signal，不能看 e.name：React Native 的 fetch 被 abort
    // 打断时经常抛 Network request failed，并不叫 AbortError。光看名字会把自己造成
    // 的超时说成「对方拒绝连接」，然后照着网络方向白查一整天。
    if (controller.signal.aborted) {
      throw new Error(
        `等桌面端 ${host} 回应超过 ${Math.round(timeoutMs / 1000)} 秒，这一轮先算了。` +
          `桌面端可能还在处理，等它跑完再同步一次即可`,
      );
    }
    // 原始错误必须带出来。这里能失败的原因太多——地址变了、两端不在同一个网、桌面端
    // 没开、被防火墙拦——压成一句猜出来的结论等于把唯一的线索删掉。
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`连不上桌面端 ${host}：${detail}。请确认两端在同一网络、桌面端已打开`);
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
  timeoutMs: number,
): Promise<Response> {
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? init.body : '';
  const timestamp = Date.now();
  const signature = signRequest(sharedKey, deviceId, timestamp, method, path, body);

  return fetchWithTimeout(
    `${baseUrl}${path}`,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Timestamp': String(timestamp),
        'X-Signature': signature,
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    timeoutMs,
  );
}

export async function pingDesktop(baseUrl: string): Promise<SyncPingResponse> {
  const res = await fetchWithTimeout(
    `${baseUrl}/sync/ping`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMs: Date.now(), appVersion: getCurrentVersion() }),
    },
    HANDSHAKE_TIMEOUT_MS,
  );
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
  const res = await fetchWithTimeout(
    `${baseUrl}/sync/pair`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    HANDSHAKE_TIMEOUT_MS,
  );
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
  const res = await signedFetch(
    baseUrl,
    sharedKey,
    deviceId,
    '/sync/exchange',
    { method: 'POST', body: payload },
    EXCHANGE_TIMEOUT_MS,
  );
  if (!res.ok) await throwResponseError(res, '同步失败');
  return (await res.json()) as SyncExchangeResponse;
}
