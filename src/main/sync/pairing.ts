import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
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

// 虚拟/隧道网卡按名字排除:VirtualBox、VMware、Hyper-V、WSL、Docker、
// Loopback、蓝牙、Tailscale、ZeroTier 等,手机在局域网里永远连不到它们。
const VIRTUAL_IFACE_NAME = /virtualbox|vmware|hyper-?v|vether|wsl|loopback|bluetooth|docker|tailscale|zerotier|hamachi|vbox/i;
// 常见虚拟化/容器网卡的 MAC 前缀(VirtualBox / VMware / Hyper-V)。
const VIRTUAL_IFACE_MAC = /^(00:00:00:00:00:00|08:00:27|0a:00:27|00:0c:29|00:50:56|00:05:69|00:15:5d|00:1a:4a):/i;
// 真实设备更可能挂在 WiFi/以太网上,优先这些名字的网卡。
const PREFERRED_IFACE_NAME = /wlan|wi-?fi|wireless|无线|以太网|ethernet/i;

function isUsableLanAddress(net: NetworkInterfaceInfo): boolean {
  if (net.family !== 'IPv4' || net.internal) return false;
  if (VIRTUAL_IFACE_MAC.test(net.mac)) return false;
  const ip = net.address;
  if (ip === '127.0.0.1' || ip.startsWith('169.254.')) return false; // loopback / APIPA
  // VirtualBox 与 Windows ICS 热点共享的默认网段,手机通常不可达
  if (ip.startsWith('192.168.56.') || ip.startsWith('192.168.99.') || ip.startsWith('192.168.137.')) return false;
  return true;
}

function firstUsableAddress(preferPreferred: boolean): string | null {
  const nets = networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    if (VIRTUAL_IFACE_NAME.test(name)) continue;
    if (preferPreferred && !PREFERRED_IFACE_NAME.test(name)) continue;
    for (const net of entries ?? []) {
      if (isUsableLanAddress(net)) return net.address;
    }
  }
  return null;
}

/** 选一个手机在局域网内可达的 IPv4 地址,供二维码展示 */
export function guessLanAddress(): string {
  // 优先 WiFi/以太网等真实网卡;再用一般候选兜底
  return firstUsableAddress(true) ?? firstUsableAddress(false) ?? '127.0.0.1';
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
