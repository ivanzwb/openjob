import type { SyncRpcRequest, SyncRpcResponse } from '@shared/sync';
import { signRequest } from '../sync/client';

interface PeerCreds {
  baseUrl: string;
  sharedKey: string;
  deviceId: string;
}

let creds: PeerCreds | null = null;

export function setPeerCreds(next: PeerCreds | null): void {
  creds = next;
}

export function getPeerCreds(): PeerCreds | null {
  return creds;
}

export async function invokeRemote<C extends string, P, R>(
  channel: C,
  payload?: P,
): Promise<{ result: R; events?: SyncRpcResponse['events'] }> {
  if (!creds) throw new Error('尚未配对桌面端');

  const body: SyncRpcRequest = { channel, payload };
  const payloadStr = JSON.stringify(body);
  const timestamp = Date.now();
  const signature = signRequest(
    creds.sharedKey,
    creds.deviceId,
    timestamp,
    'POST',
    '/sync/rpc',
    payloadStr,
  );

  const res = await fetch(`${creds.baseUrl}/sync/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': creds.deviceId,
      'X-Timestamp': String(timestamp),
      'X-Signature': signature,
    },
    body: payloadStr,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `RPC 失败 (${res.status})`);
  }

  const data = (await res.json()) as SyncRpcResponse;
  return { result: data.result as R, events: data.events };
}

/** 从 llm:chat 事件流拼出完整助手回复 */
export function textFromStreamEvents(
  events: SyncRpcResponse['events'],
): { text: string; sessionId: string | null } {
  let text = '';
  let sessionId: string | null = null;
  for (const ev of events ?? []) {
    if (ev.channel === 'stream:delta') {
      const p = ev.payload as { delta?: string };
      text += p.delta ?? '';
    }
    if (ev.channel === 'stream:done') {
      const p = ev.payload as { sessionId?: string; contentMd?: string };
      sessionId = p.sessionId ?? null;
      if (p.contentMd) text = p.contentMd;
    }
    if (ev.channel === 'stream:error') {
      const p = ev.payload as { message?: string };
      throw new Error(p.message ?? '流式请求失败');
    }
  }
  return { text, sessionId };
}

/** 从长任务事件流提取最后一条进度消息 */
export function jobMessageFromEvents(events: SyncRpcResponse['events']): string {
  let last = '任务已完成';
  for (const ev of events ?? []) {
    if (ev.channel !== 'job:progress') continue;
    const p = ev.payload as { message?: string; error?: string; done?: boolean };
    if (p.error) return p.error;
    if (p.message) last = p.message;
  }
  return last;
}
