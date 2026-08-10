import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { v4 as uuidv4 } from 'uuid';

export interface DeviceIdentity {
  deviceId: string;
  displayName: string;
  platform: string;
}

function readMeta(raw: SQLiteDatabase, key: string): string | undefined {
  return raw.getFirstSync<{ value: string }>(`SELECT value FROM sync_meta WHERE key = ?`, key)
    ?.value;
}

function writeMeta(raw: SQLiteDatabase, key: string, value: string): void {
  raw.runSync(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

export async function getDeviceIdentity(raw: SQLiteDatabase): Promise<DeviceIdentity> {
  let deviceId = readMeta(raw, 'deviceId');
  if (!deviceId) {
    deviceId = (await SecureStore.getItemAsync('openjob.deviceId')) ?? uuidv4();
    await SecureStore.setItemAsync('openjob.deviceId', deviceId);
    writeMeta(raw, 'deviceId', deviceId);
  }

  let displayName = readMeta(raw, 'displayName');
  if (!displayName) {
    displayName = '手机端';
    writeMeta(raw, 'displayName', displayName);
  }

  return { deviceId, displayName, platform: 'mobile' };
}
