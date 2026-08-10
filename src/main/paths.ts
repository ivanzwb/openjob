import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppPaths } from '@shared/ipc';

/**
 * 所有可写数据一律落在 userData 下。
 * 安装后应用目录是只读的，任何写入项目目录的做法在打包版本里都会失败。
 */
export function getAppPaths(): AppPaths {
  const userData = app.getPath('userData');
  return {
    userData,
    dbFile: join(userData, 'openjob.db'),
    reposDir: join(userData, 'repos'),
    cacheDir: join(userData, 'cache'),
    backupsDir: join(userData, 'backups'),
  };
}

export function ensureDirs(): AppPaths {
  const paths = getAppPaths();
  for (const dir of [paths.userData, paths.reposDir, paths.cacheDir, paths.backupsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return paths;
}
