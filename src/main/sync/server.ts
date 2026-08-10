import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  SyncExchangeRequest,
  SyncExchangeResponse,
  SyncPairRequest,
  SyncPairResponse,
  SyncPingRequest,
  SyncPingResponse,
  SyncStatus,
} from '@shared/sync';
import { getDeviceIdentity } from './identity';
import { getRawDb } from '../db';
import { verifyRequest } from './crypto';
import { collectChangeSet } from './collect';
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
      };
      void input.clientMs;
      sendJson(res, 200, response);
      return;
    }

    if (path === '/sync/pair' && method === 'POST') {
      const input = JSON.parse(body) as SyncPairRequest;
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
      const clockOffsetMs = Date.now() - input.clientMs;
      const identity = getDeviceIdentity(getRawDb());
      const result = handleExchange({
        peerDeviceId: auth.deviceId,
        remote: input.changes,
        clockOffsetMs,
        direction: 'auto',
        remoteAddress: clientAddress(req),
      });

      const outbound = collectChangeSet(getRawDb(), identity.deviceId, input.sinceSeq);

      const response: SyncExchangeResponse = {
        changes: outbound,
        appliedCount: result.appliedCount,
        conflictCount: result.conflictCount,
        runId: result.runId,
        status: result.status,
        serverMs: Date.now(),
      };

      emit('sync:finished', {
        runId: result.runId,
        peerDeviceId: auth.deviceId,
        status: result.status,
        conflictCount: result.conflictCount,
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

      const input = JSON.parse(body) as { channel: string; payload?: unknown };
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
