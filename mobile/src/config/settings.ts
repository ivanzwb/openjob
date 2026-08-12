import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_CONFIG, mergeAppConfig, type AppConfig } from '@shared/config';

const SETTING_ID = 'default';
const SECRET_PREFIX = 'openjob.secret.';

let configCache: AppConfig | null = null;

export function getMobileConfig(): AppConfig {
  if (!configCache) configCache = structuredClone(DEFAULT_CONFIG);
  return configCache;
}

export async function getMobileSecret(ref: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SECRET_PREFIX + ref);
  } catch {
    return null;
  }
}

export async function hydrateAppSettingsFromDb(db: SQLiteDatabase): Promise<void> {
  const row = db.getFirstSync<{ config_json: string; secrets_json: string }>(
    `SELECT config_json, secrets_json FROM app_setting WHERE id = ?`,
    SETTING_ID,
  );
  if (!row) {
    configCache = structuredClone(DEFAULT_CONFIG);
    return;
  }

  try {
    configCache = mergeAppConfig(JSON.parse(row.config_json) as Partial<AppConfig>);
  } catch {
    configCache = structuredClone(DEFAULT_CONFIG);
  }

  try {
    const secrets = JSON.parse(row.secrets_json) as Record<string, string>;
    await Promise.all(
      Object.entries(secrets).map(([ref, value]) =>
        SecureStore.setItemAsync(SECRET_PREFIX + ref, value),
      ),
    );
  } catch {
    // 密钥解析失败时保留 SecureStore 里已有值
  }
}

export function invalidateMobileConfigCache(): void {
  configCache = null;
}
