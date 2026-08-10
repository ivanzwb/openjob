import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db';
import { generatePairingCode, generateSharedKey } from './crypto';
import { getDeviceIdentity } from './identity';
import type { PairingPayload } from '@shared/sync';

export interface PairingSession {
  code: string;
  sharedKey: string;
  expiresAt: number;
}

export interface PeerInfo {
  deviceId: string;
  displayName: string;
  platform: string;
  lastAddress: string | null;
  lastSyncAt: number | null;
  pairedAt: number;
}

let activePairing: PairingSession | null = null;

/** 取第一个非 internal 的 IPv4 地址，供二维码展示 */
export function guessLanAddress(): string {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

export function startPairing(ttlMs = 5 * 60 * 1000): PairingSession {
  activePairing = {
    code: generatePairingCode(),
    sharedKey: generateSharedKey(),
    expiresAt: Date.now() + ttlMs,
  };
  return activePairing;
}

export function cancelPairing(): void {
  activePairing = null;
}

export function getActivePairing(): PairingSession | null {
  if (!activePairing) return null;
  if (Date.now() > activePairing.expiresAt) {
    activePairing = null;
    return null;
  }
  return activePairing;
}

export function buildPairingPayload(port: number): PairingPayload | null {
  const session = getActivePairing();
  if (!session) return null;
  const identity = getDeviceIdentity(getRawDb());
  return {
    v: 1,
    host: guessLanAddress(),
    port,
    code: session.code,
    deviceId: identity.deviceId,
    displayName: identity.displayName,
  };
}

export interface PairRequest {
  code: string;
  deviceId: string;
  displayName: string;
  platform: string;
}

export interface PairResult {
  sharedKey: string;
  deviceId: string;
  displayName: string;
}

/** 对端扫码后提交配对码，验证通过后落库并返回共享密钥 */
export function completePairing(req: PairRequest, remoteAddress: string): PairResult {
  const session = getActivePairing();
  if (!session) throw new Error('配对已过期，请在桌面端重新生成二维码');
  if (req.code !== session.code) throw new Error('配对码不正确');

  const identity = getDeviceIdentity(getRawDb());
  const db = getDb();
  const now = Date.now();

  db.insert(schema.syncPeer)
    .values({
      deviceId: req.deviceId,
      displayName: req.displayName.trim() || '手机端',
      platform: req.platform,
      sharedKey: session.sharedKey,
      lastAddress: remoteAddress,
      lastLocalSeq: 0,
      lastRemoteSeq: 0,
      lastSyncAt: null,
      pairedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.syncPeer.deviceId,
      set: {
        displayName: req.displayName.trim() || '手机端',
        platform: req.platform,
        sharedKey: session.sharedKey,
        lastAddress: remoteAddress,
        pairedAt: now,
      },
    })
    .run();

  activePairing = null;

  return {
    sharedKey: session.sharedKey,
    deviceId: identity.deviceId,
    displayName: identity.displayName,
  };
}

export function listPeers(): PeerInfo[] {
  return getDb()
    .select()
    .from(schema.syncPeer)
    .all()
    .map((row) => ({
      deviceId: row.deviceId,
      displayName: row.displayName,
      platform: row.platform,
      lastAddress: row.lastAddress,
      lastSyncAt: row.lastSyncAt,
      pairedAt: row.pairedAt,
    }));
}

export function getPeer(deviceId: string) {
  return getDb().select().from(schema.syncPeer).where(eq(schema.syncPeer.deviceId, deviceId)).get();
}

export function removePeer(deviceId: string): void {
  getDb().delete(schema.syncPeer).where(eq(schema.syncPeer.deviceId, deviceId)).run();
}

export function updatePeerWatermarks(
  deviceId: string,
  lastLocalSeq: number,
  lastRemoteSeq: number,
  address?: string,
): void {
  const db = getDb();
  const patch: Partial<typeof schema.syncPeer.$inferInsert> = {
    lastLocalSeq,
    lastRemoteSeq,
    lastSyncAt: Date.now(),
  };
  if (address) patch.lastAddress = address;
  db.update(schema.syncPeer).set(patch).where(eq(schema.syncPeer.deviceId, deviceId)).run();
}

export function newRunId(): string {
  return randomUUID();
}
