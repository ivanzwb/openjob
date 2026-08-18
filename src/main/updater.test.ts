/**
 * 自动更新的回归防线。
 *
 * 线上 bug：打包版点「立即检查」毫无反应。根因是 electron-updater 的 autoUpdater
 * 由 CJS getter 惰性导出（Object.defineProperty(exports, "autoUpdater", { get })），
 * Node 的 ESM-CJS 互操作（cjs-module-lexer 静态分析）识别不到 getter 式导出，
 * `import('electron-updater')` 解构拿到的 autoUpdater 是 undefined，随后
 * `autoUpdater.autoDownload = false` 抛 TypeError。模块级 updaterPromise 把 reject
 * 永久缓存，checkForUpdates 又在 try 外 await，于是 IPC reject 到渲染端被 .then 吞掉。
 *
 * 这里把 electron-updater mock 成真实的形状——只有 default（module.exports）上有
 * autoUpdater，命名导出缺失——修复前用例会挂，修复后通过。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpdater, state } = vi.hoisted(() => {
  const mockUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
  };
  return {
    mockUpdater,
    state: { failInit: false, isPackaged: true, feedUrl: '' },
  };
});

// electron-updater：只有 default 上有 autoUpdater（模拟 CJS getter 导出经
// ESM 互操作后命名导出缺失的真实形状）
vi.mock('electron-updater', () => ({
  default: {
    get autoUpdater() {
      if (state.failInit) throw new Error('init boom');
      return mockUpdater;
    },
  },
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getVersion: () => '1.2.3',
  },
}));

vi.mock('./config', () => ({
  getConfig: () => ({ update: { feedUrl: state.feedUrl, checkOnStartup: true } }),
}));

vi.mock('./ipc/bridge', () => ({
  emit: vi.fn(),
}));

import type * as UpdaterModule from './updater';
let updater: typeof UpdaterModule;

beforeEach(async () => {
  state.failInit = false;
  state.isPackaged = true;
  state.feedUrl = '';
  mockUpdater.autoDownload = true;
  mockUpdater.autoInstallOnAppQuit = true;
  mockUpdater.setFeedURL.mockReset();
  mockUpdater.checkForUpdates.mockReset();
  mockUpdater.downloadUpdate.mockReset();
  mockUpdater.quitAndInstall.mockReset();
  mockUpdater.on.mockReset();
  // 真实 electron-updater 在 checkForUpdates 一开始就会同步发出
  // checking-for-update 事件，这里模拟同样的行为：状态应从旧值刷新到 checking
  mockUpdater.checkForUpdates.mockImplementation(() => {
    const checking = mockUpdater.on.mock.calls.find(([e]) => e === 'checking-for-update')?.[1] as
      | (() => void)
      | undefined;
    checking?.();
  });
  vi.resetModules();
  updater = await import('./updater');
});

describe('getUpdater 的 ESM-CJS 互操作', () => {
  it('只有 default 形状（真实 CJS interop）也能拿到 autoUpdater 并完成检查', async () => {
    const status = await updater.checkForUpdates();

    expect(mockUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'ivanzwb',
      repo: 'openjob',
    });
    expect(mockUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    // 初始化配置在拿到实例后生效
    expect(mockUpdater.autoDownload).toBe(false);
    expect(mockUpdater.autoInstallOnAppQuit).toBe(true);
    // mock 同步发出 checking-for-update，状态推进到 checking
    expect(status).toMatchObject({ state: 'checking' });
  });

  it('初始化失败落成 error 状态，而不是 reject 到渲染端静默无反应', async () => {
    state.failInit = true;
    const status = await updater.checkForUpdates();

    expect(status).toMatchObject({ state: 'error', message: 'init boom' });
  });

  it('初始化失败后清掉缓存，下次点「立即检查」能重试成功', async () => {
    state.failInit = true;
    await updater.checkForUpdates();
    expect(mockUpdater.checkForUpdates).not.toHaveBeenCalled();

    state.failInit = false;
    const status = await updater.checkForUpdates();

    expect(mockUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(status.state).not.toBe('error');
  });

  it('开发态（未打包）返回 disabled 且不触碰 electron-updater', async () => {
    state.isPackaged = false;
    const status = await updater.checkForUpdates();

    expect(status).toMatchObject({ state: 'disabled' });
    expect(mockUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('配置了 feedUrl 就走 generic 源', async () => {
    state.feedUrl = 'https://example.com/updates/';
    await updater.checkForUpdates();

    expect(mockUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://example.com/updates/',
    });
  });
});

describe('事件驱动状态流转', () => {
  it('update-not-available 事件把状态推到 upToDate', async () => {
    await updater.checkForUpdates();

    const handler = mockUpdater.on.mock.calls.find(([e]) => e === 'update-not-available')?.[1] as
      | (() => void)
      | undefined;
    expect(handler).toBeDefined();
    handler?.();

    expect(updater.getUpdateStatus()).toMatchObject({ state: 'upToDate', version: '1.2.3' });
  });

  it('update-downloaded 后 quitAndInstall 才会真正安装', async () => {
    await updater.quitAndInstall();
    expect(mockUpdater.quitAndInstall).not.toHaveBeenCalled();

    await updater.checkForUpdates();
    const handler = mockUpdater.on.mock.calls.find(([e]) => e === 'update-downloaded')?.[1] as
      | ((info: { version: string }) => void)
      | undefined;
    handler?.({ version: '2.0.0' });

    await updater.quitAndInstall();
    expect(mockUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
