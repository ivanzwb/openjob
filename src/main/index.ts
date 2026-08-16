import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { ensureDirs } from './paths';
import { registerIpcHandlers } from './ipc';
import { closeDb, getDb } from './db';
import { scheduleStartupCheck } from './updater';
import { startSyncServer } from './sync';
import { applyAppIcon } from './icon';
import { getConfig } from './config';
import { trackWindowTheme, WINDOW_BACKGROUND } from './theme';

/**
 * 启动冒烟模式：OPENJOB_SMOKE=1 时按真实链路启动（目录 → DB 迁移 →
 * IPC 注册 → 同步服务 → 建窗加载 renderer），全部成功打标
 * OPENJOB_SMOKE_OK 后退出。任何一步失败都会导致非零退出码，
 * CI 靠它抓住「改坏了启动链但单测没覆盖到」的回归。
 */
const SMOKE = process.env['OPENJOB_SMOKE'] === '1';
if (SMOKE) {
  // 冒烟用临时 userData，绝不污染真实数据，也让 DB/同步落在同一目录下
  app.setPath('userData', join(app.getPath('temp'), `openjob-smoke-${process.pid}`));
}

const isDev = !app.isPackaged;

/** 单实例锁：多开会导致两个进程同时写同一个 SQLite 文件 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const icon = applyAppIcon();
  // 主题在建窗前就得定下来：窗口底色和 preload 注入的初值都取自它，
  // 否则浅色用户每次启动都会先闪一下深色。
  const theme = getConfig().ui.theme;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_BACKGROUND[theme],
    title: 'OpenJob',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // 安全基线：渲染进程拿不到 Node，只能走 preload 暴露的白名单通道
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload 要求关闭 sandbox；隔离仍由 contextIsolation 保证
      sandbox: false,
      additionalArguments: [`--ui-theme=${theme}`],
    },
  });
  trackWindowTheme(mainWindow);

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // 冒烟模式：renderer 加载完成即视为启动链全通，打标退出
  if (SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('OPENJOB_SMOKE_OK');
      app.exit(0);
    });
    mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`OPENJOB_SMOKE_FAIL: renderer load failed (${code}) ${desc}`);
      app.exit(1);
    });
    mainWindow.webContents.once('render-process-gone', (_e, details) => {
      console.error(`OPENJOB_SMOKE_FAIL: renderer gone (${details.reason})`);
      app.exit(1);
    });
  }

  // 外链一律交给系统浏览器，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  ensureDirs();
  // 尽早建库跑迁移，让 schema 问题在启动时暴露而不是首次查询时
  getDb();
  registerIpcHandlers();
  startSyncServer();
  createWindow();
  if (!SMOKE) scheduleStartupCheck();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', closeDb);
