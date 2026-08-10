import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { installSyncTriggers } from './triggers';

export interface DeviceIdentity {
  deviceId: string;
  displayName: string;
  platform: NodeJS.Platform;
}

function readMeta(raw: Database, key: string): string | undefined {
  const row = raw.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeMeta(raw: Database, key: string, value: string): void {
  raw
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/**
 * 本机在同步网络里的身份。一旦生成就不再变化——它是对端水位线的键，
 * 换了 id 等于变成一台新设备，会把已同步过的内容当成新数据重新推一遍。
 */
export function getDeviceIdentity(raw: Database): DeviceIdentity {
  let deviceId = readMeta(raw, 'deviceId');
  if (!deviceId) {
    deviceId = randomUUID();
    writeMeta(raw, 'deviceId', deviceId);
  }

  let displayName = readMeta(raw, 'displayName');
  if (!displayName) {
    displayName = hostname() || '桌面端';
    writeMeta(raw, 'displayName', displayName);
  }

  return { deviceId, displayName, platform: process.platform };
}

export function setDisplayName(raw: Database, name: string): void {
  writeMeta(raw, 'displayName', name.trim() || hostname());
}

/**
 * 建库后的同步层初始化。必须在 migrate 之后执行：触发器要写 sync_oplog，
 * 而这两张表由迁移创建。
 */
export function initSyncLayer(raw: Database): DeviceIdentity {
  const identity = getDeviceIdentity(raw);

  // 触发器读 writeAs 决定变更归属。默认就是本机，应用对端变更时才临时改写。
  writeMeta(raw, 'writeAs', identity.deviceId);

  installSyncTriggers(raw, identity.deviceId);
  return identity;
}
