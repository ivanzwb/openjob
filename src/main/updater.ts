import { app } from 'electron';
import type { autoUpdater as ElectronAutoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/ipc';
import { getConfig } from './config';
import { emit } from './ipc/bridge';

/**
 * 自动更新。
 *
 * 默认查官方发布渠道（GitHub Release，安装包与 latest.yml 由 electron-builder
 * 的 provider: github 挂在那里），开箱就能收到新版本。
 * 自己构建自己分发的，在 config.update.feedUrl 填上自己的目录即可覆盖。
 *
 * 想彻底不联网就关掉 checkOnStartup：此后只有用户点「立即检查」才会发请求。
 */

type Updater = typeof ElectronAutoUpdater;

/** 官方发布渠道，和 electron-builder.yml 的 publish 配置指向同一处 */
const GITHUB_FEED = { provider: 'github', owner: 'ivanzwb', repo: 'openjob' } as const;

function resolveFeed(): Parameters<Updater['setFeedURL']>[0] {
  const feedUrl = getConfig().update.feedUrl.trim();
  if (!feedUrl) return GITHUB_FEED;
  return { provider: 'generic', url: feedUrl };
}

let status: UpdateStatus = { state: 'idle' };
let updaterPromise: Promise<Updater | null> | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  emit('update:status', next);
}

function getUpdater(): Promise<Updater | null> {
  if (updaterPromise == null) {
    updaterPromise = (async (): Promise<Updater | null> => {
      // 开发态没有 app-update.yml，electron-updater 会直接抛错
      if (!app.isPackaged) return null;

      // electron-updater 是 CJS 模块：autoUpdater 由 Object.defineProperty 的 getter
      // 惰性导出。Node 的 ESM-CJS 互操作（cjs-module-lexer 静态分析）识别不到 getter
      // 式导出，import() 解构拿到的 autoUpdater 是 undefined——这是线上「立即检查」
      // 点了没反应的根因。default 就是 module.exports，只有它能触达这个 getter。
      const mod = (await import('electron-updater')) as unknown as {
        default?: { autoUpdater: Updater };
      };
      const { autoUpdater } = (mod.default ?? mod) as { autoUpdater: Updater };

      // 下载完不自动重启，交给用户点「立即重启安装」
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
      autoUpdater.on('update-available', (info) => {
        setStatus({ state: 'available', version: info.version });
        void autoUpdater.downloadUpdate().catch((err: unknown) => {
          setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
        });
      });
      autoUpdater.on('update-not-available', () =>
        setStatus({ state: 'upToDate', version: app.getVersion() }),
      );
      autoUpdater.on('download-progress', (p) =>
        setStatus({ state: 'downloading', percent: Math.round(p.percent) }),
      );
      autoUpdater.on('update-downloaded', (info) =>
        setStatus({ state: 'downloaded', version: info.version }),
      );
      autoUpdater.on('error', (err) =>
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
      );

      return autoUpdater;
    })();

    // 初始化失败不缓存 rejected promise：清掉缓存，下次点「立即检查」还能重试，
    // 而不是永久静默失败
    updaterPromise = updaterPromise.catch((err: unknown) => {
      updaterPromise = null;
      throw err;
    });
  }

  return updaterPromise;
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  try {
    const updater = await getUpdater();
    if (!updater) {
      setStatus({ state: 'disabled', message: '开发模式下不检查更新' });
      return status;
    }
    updater.setFeedURL(resolveFeed());
    await updater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  return status;
}

/** 重启并安装已下载的包；未下载完时无操作 */
export async function quitAndInstall(): Promise<void> {
  if (status.state !== 'downloaded') return;
  try {
    const updater = await getUpdater();
    updater?.quitAndInstall();
  } catch (err) {
    // 安装前的初始化失败同样落成 error 状态，而不是静默
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

/** 启动时的静默检查，失败不打扰用户 */
export function scheduleStartupCheck(): void {
  if (!getConfig().update.checkOnStartup || !app.isPackaged) return;

  // 等窗口和首屏渲染完再查，别和启动抢带宽
  setTimeout(() => void checkForUpdates(), 8000);
}
