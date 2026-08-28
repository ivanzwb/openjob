import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  SyncExchangeRequest,
  SyncExchangeResponse,
  SyncPairRequest,
  SyncPairResponse,
  SyncPingRequest,
  SyncPingResponse,
  SyncRpcRequest,
  SyncStatus,
} from '@shared/sync';
import { getDeviceIdentity } from './identity';
import { getRawDb } from '../db';
import { verifyRequest } from './crypto';
import { collectChangeSet, collectFullChangeSet } from './collect';
import {
  buildPairingPayload,
  completePairing,
  getActivePairing,
  guessLanAddress,
  listPeers,
  startPairing,
  cancelPairing,
  getPeer,
} from './pairing';
import { handleExchange } from './orchestrator';
import { invokeRpc, isJobChannel, isStreamChannel, waitForStreamEvents } from './rpc';
import { checkPeerVersion, localAppVersion, VERSION_MISMATCH_STATUS } from './versionGate';
import { emit } from '../ipc/bridge';

const DEFAULT_PORT = 19721;

let server: Server | null = null;
let listenPort: number | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 把版本不一致告诉桌面用户。
 *
 * 手机端那边会看到自己的提示，但被拒的这一端往往是桌面（自动更新跑在前面），
 * 只在手机上提示会让人以为是手机坏了。节流是因为自动同步每 60 秒重试一次，
 * 不限速的话设置页会被同一条消息刷满。
 */
const MISMATCH_NOTICE_INTERVAL_MS = 5 * 60_000;
let lastMismatchNoticeAt = 0;

function notifyVersionMismatch(peerName: string, peerVersion: string | null): void {
  const now = Date.now();
  if (now - lastMismatchNoticeAt < MISMATCH_NOTICE_INTERVAL_MS) return;
  lastMismatchNoticeAt = now;
  emit('sync:versionMismatch', {
    peerName,
    peerVersion,
    desktopVersion: localAppVersion(),
  });
}

function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? '';
  return req.socket.remoteAddress ?? '';
}

function authenticate(
  req: IncomingMessage,
  path: string,
  body: string,
): { deviceId: string; sharedKey: string } | null {
  const deviceId = req.headers['x-device-id'];
  const timestamp = Number(req.headers['x-timestamp']);
  const signature = req.headers['x-signature'];
  if (typeof deviceId !== 'string' || !signature || !Number.isFinite(timestamp)) return null;

  const peer = getPeer(deviceId);
  if (!peer) return null;

  const ok = verifyRequest(
    peer.sharedKey,
    deviceId,
    timestamp,
    req.method ?? 'GET',
    path,
    body,
    String(signature),
  );
  return ok ? { deviceId, sharedKey: peer.sharedKey } : null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, X-Device-Id, X-Timestamp, X-Signature',
    });
    res.end();
    return;
  }

  try {
    const body = method === 'POST' ? await readBody(req) : '';

    if (path === '/sync/ping' && method === 'POST') {
      const input = JSON.parse(body || '{}') as SyncPingRequest;
      const identity = getDeviceIdentity(getRawDb());
      const response: SyncPingResponse = {
        serverMs: Date.now(),
        deviceId: identity.deviceId,
        displayName: identity.displayName,
        appVersion: localAppVersion(),
      };
      void input.clientMs;
      sendJson(res, 200, response);
      return;
    }

    if (path === '/sync/pair' && method === 'POST') {
      const input = JSON.parse(body) as SyncPairRequest;

      // 版本不一致时连配对都不建立：配上了却一次也不能同步，只会让用户以为是别的毛病
      const gate = checkPeerVersion(input.appVersion);
      if (!gate.ok) {
        notifyVersionMismatch(input.displayName, gate.peerVersion);
        sendJson(res, VERSION_MISMATCH_STATUS, gate.body);
        return;
      }

      const result: SyncPairResponse = completePairing(input, clientAddress(req));
      emit('sync:paired', { deviceId: input.deviceId, displayName: input.displayName });
      sendJson(res, 200, result);
      return;
    }

    if (path === '/sync/exchange' && method === 'POST') {
      const auth = authenticate(req, path, body);
      if (!auth) {
        sendJson(res, 401, { error: '未授权' });
        return;
      }

      const input = JSON.parse(body) as SyncExchangeRequest;

      // 必须挡在 handleExchange 之前：那一步就开始往库里写了。桌面端在这条链路上
      // 是唯一的服务端，所以闸门只设在这里，手机端不再自行判断，免得两边规则跑偏。
      const gate = checkPeerVersion(input.appVersion);
      if (!gate.ok) {
        const peer = getPeer(auth.deviceId);
        notifyVersionMismatch(peer?.displayName ?? auth.deviceId, gate.peerVersion);
        sendJson(res, VERSION_MISMATCH_STATUS, gate.body);
        return;
      }

      const clockOffsetMs = Date.now() - input.clientMs;
      const identity = getDeviceIdentity(getRawDb());
      const result = handleExchange({
        peerDeviceId: auth.deviceId,
        remote: input.changes,
        sinceSeq: input.sinceSeq,
        clockOffsetMs,
        direction: 'auto',
        remoteAddress: clientAddress(req),
        full: input.full === true,
      });

      const outbound = input.full
        ? collectFullChangeSet(getRawDb(), identity.deviceId)
        : collectChangeSet(getRawDb(), identity.deviceId, input.sinceSeq);

      const response: SyncExchangeResponse = {
        changes: outbound,
        appliedCount: result.appliedCount,
        overwriteCount: result.overwriteCount,
        skippedCount: result.skippedCount,
        runId: result.runId,
        serverMs: Date.now(),
        appVersion: localAppVersion(),
      };

      emit('sync:finished', {
        runId: result.runId,
        peerDeviceId: auth.deviceId,
        appliedCount: result.appliedCount,
        overwriteCount: result.overwriteCount,
        skippedCount: result.skippedCount,
      });

      sendJson(res, 200, response);
      return;
    }

    if (path === '/sync/rpc' && method === 'POST') {
      const auth = authenticate(req, path, body);
      if (!auth) {
        sendJson(res, 401, { error: '未授权' });
        return;
      }

      const input = JSON.parse(body) as SyncRpcRequest;

      // RPC 也要挡：它转发到的 IPC 处理器同样会写桌面端的库，老版本手机端发来
      // 旧形状的 payload，照样能写出一堆残缺数据。
      const gate = checkPeerVersion(input.appVersion);
      if (!gate.ok) {
        const peer = getPeer(auth.deviceId);
        notifyVersionMismatch(peer?.displayName ?? auth.deviceId, gate.peerVersion);
        sendJson(res, VERSION_MISMATCH_STATUS, gate.body);
        return;
      }

      const channel = input.channel as Parameters<typeof invokeRpc>[0];
      const result = await invokeRpc(channel, (input.payload ?? undefined) as never);

      let events: Array<{ channel: string; payload: unknown }> | undefined;
      if (isStreamChannel(channel)) {
        const started = result as { streamId: string };
        const collected = await waitForStreamEvents(started.streamId);
        events = collected.events;
      } else if (isJobChannel(channel)) {
        const started = result as { jobId: string };
        const collected = await waitForStreamEvents(started.jobId, 600_000);
        events = collected.events;
      }

      sendJson(res, 200, { result, events });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}

export function startSyncServer(port = DEFAULT_PORT): number {
  if (server) return listenPort ?? port;

  server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  // A failed listen() used to be silent: pairing returned a port that was
  // never bound, so phones got Connection reset while a QR was on screen.
  // Log the error and clear state so the next beginPairing() retries.
  server.on('error', (err) => {
    console.error(`[sync] failed to listen on ${port}:`, err.message);
    server = null;
    listenPort = null;
  });

  server.listen(port, '0.0.0.0');
  listenPort = port;
  return port;
}

export function stopSyncServer(): void {
  server?.close();
  server = null;
  listenPort = null;
}

export function getSyncStatus(): SyncStatus {
  const peers = listPeers();
  return {
    running: server !== null,
    port: listenPort,
    host: guessLanAddress(),
    pairingActive: getActivePairing() !== null,
    peers: peers.map((p) => ({
      deviceId: p.deviceId,
      displayName: p.displayName,
      platform: p.platform,
      lastSyncAt: p.lastSyncAt,
    })),
  };
}

export function beginPairing(): { port: number; payload: ReturnType<typeof buildPairingPayload> } {
  const port = listenPort ?? startSyncServer();
  startPairing();
  return { port, payload: buildPairingPayload(port) };
}

export function endPairing(): void {
  cancelPairing();
}

export { DEFAULT_PORT };
