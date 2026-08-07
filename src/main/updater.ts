import { app } from 'electron';
import type { autoUpdater as ElectronAutoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/ipc';
import { getConfig } from './config';
import { emit } from './ipc/bridge';

/**
 * 自动更新。
 *
 * 更新源不写死在打包配置里，而是运行时从 config.update.feedUrl 读——
 * 这个项目没有固定的发布地址，谁自己构建谁指向自己的目录。
 * feedUrl 为空时整个模块不发起任何网络请求。
 */

type Updater = typeof ElectronAutoUpdater;

let status: UpdateStatus = { state: 'idle' };
let updaterPromise: Promise<Updater | null> | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  emit('update:status', next);
}

async function getUpdater(): Promise<Updater | null> {
  updaterPromise ??= (async (): Promise<Updater | null> => {
    // 开发态没有 app-update.yml，electron-updater 会直接抛错
    if (!app.isPackaged) return null;

    const { autoUpdater } = await import('electron-updater');
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

  return updaterPromise;
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const feedUrl = getConfig().update.feedUrl.trim();
  if (!feedUrl) {
    setStatus({ state: 'disabled', message: '未配置更新源，可在设置中填写' });
    return status;
  }

  const updater = await getUpdater();
  if (!updater) {
    setStatus({ state: 'disabled', message: '开发模式下不检查更新' });
    return status;
  }

  try {
    updater.setFeedURL({ provider: 'generic', url: feedUrl });
    await updater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  return status;
}

/** 重启并安装已下载的包；未下载完时无操作 */
export async function quitAndInstall(): Promise<void> {
  if (status.state !== 'downloaded') return;
  const updater = await getUpdater();
  updater?.quitAndInstall();
}

/** 启动时的静默检查，失败不打扰用户 */
export function scheduleStartupCheck(): void {
  const { feedUrl, checkOnStartup } = getConfig().update;
  if (!checkOnStartup || !feedUrl.trim() || !app.isPackaged) return;

  // 等窗口和首屏渲染完再查，别和启动抢带宽
  setTimeout(() => void checkForUpdates(), 8000);
}
