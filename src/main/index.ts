import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { ensureDirs } from './paths';
import { registerIpcHandlers } from './ipc';
import { closeDb, getDb } from './db';
import { scheduleStartupCheck } from './updater';
import { startSyncServer } from './sync';

const isDev = !app.isPackaged;

/** 单实例锁：多开会导致两个进程同时写同一个 SQLite 文件 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    title: 'openJob',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // 安全基线：渲染进程拿不到 Node，只能走 preload 暴露的白名单通道
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload 要求关闭 sandbox；隔离仍由 contextIsolation 保证
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

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
  scheduleStartupCheck();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', closeDb);
