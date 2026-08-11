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
export function streamResultFromEvents(events: SyncRpcResponse['events']): {
  text: string;
  sessionId: string | null;
  evidenceKind: 'model' | 'web' | 'code';
  error: string | null;
} {
  let text = '';
  let sessionId: string | null = null;
  let evidenceKind: 'model' | 'web' | 'code' = 'model';
  let error: string | null = null;
  for (const ev of events ?? []) {
    if (ev.channel === 'stream:delta') {
      const p = ev.payload as { delta?: string };
      text += p.delta ?? '';
    }
    if (ev.channel === 'stream:done') {
      const p = ev.payload as {
        sessionId?: string;
        contentMd?: string;
        evidenceKind?: 'model' | 'web' | 'code';
      };
      sessionId = p.sessionId ?? null;
      if (p.contentMd) text = p.contentMd;
      if (p.evidenceKind) evidenceKind = p.evidenceKind;
    }
    if (ev.channel === 'stream:error') {
      const p = ev.payload as { message?: string };
      error = p.message ?? '流式请求失败';
    }
  }
  return { text, sessionId, evidenceKind, error };
}

/** @deprecated 使用 streamResultFromEvents */
export function textFromStreamEvents(
  events: SyncRpcResponse['events'],
): { text: string; sessionId: string | null } {
  const { text, sessionId } = streamResultFromEvents(events);
  return { text, sessionId };
}

/** 从长任务事件流提取结果 */
export function jobResultFromEvents(events: SyncRpcResponse['events']): {
  message: string;
  error: string | null;
} {
  let message = '任务已完成';
  let error: string | null = null;
  for (const ev of events ?? []) {
    if (ev.channel !== 'job:progress') continue;
    const p = ev.payload as { message?: string; error?: string | null; done?: boolean };
    if (p.error) error = p.error;
    if (p.message) message = p.message;
  }
  return { message, error };
}

/** @deprecated 使用 jobResultFromEvents */
export function jobMessageFromEvents(events: SyncRpcResponse['events']): string {
  const { message, error } = jobResultFromEvents(events);
  return error ?? message;
}
