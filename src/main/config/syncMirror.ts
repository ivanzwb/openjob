import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { getConfig } from './index';
import { exportSecretsPlain } from './secrets';

const SETTING_ID = 'default';

/** 把当前 config.json + secrets 镜像进 app_setting，供 P2P 同步 */
export function mirrorAppSettings(): void {
  const config = getConfig();
  const secrets = exportSecretsPlain();
  const now = Date.now();
  const payload = {
    id: SETTING_ID,
    configJson: JSON.stringify(config),
    secretsJson: JSON.stringify(secrets),
    updatedAt: now,
  };

  getDb()
    .insert(schema.appSetting)
    .values(payload)
    .onConflictDoUpdate({
      target: schema.appSetting.id,
      set: {
        configJson: payload.configJson,
        secretsJson: payload.secretsJson,
        updatedAt: now,
      },
    })
    .run();
}

/** 首次升级后若尚无行，用磁盘配置种子一条 */
export function ensureAppSettingsMirrored(): void {
  const row = getDb()
    .select()
    .from(schema.appSetting)
    .where(eq(schema.appSetting.id, SETTING_ID))
    .get();
  if (!row) mirrorAppSettings();
}
