import { BrowserWindow, ipcMain } from 'electron';
import type {
  IpcEventChannel,
  IpcEventMap,
  IpcInvokeChannel,
  IpcReq,
  IpcRes,
} from '@shared/ipc';

type Handler<C extends IpcInvokeChannel> = (payload: IpcReq<C>) => Promise<IpcRes<C>> | IpcRes<C>;

type EventListener = <C extends IpcEventChannel>(channel: C, payload: IpcEventMap[C]) => void;

const eventListeners = new Set<EventListener>();

/** 供局域网 RPC 订阅流式/任务事件，不经过 Electron 窗口 */
export function subscribeEmit(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/**
 * 类型安全的 handler 注册。通道名与出入参类型都由 IpcInvokeMap 约束，
 * 写错通道名或返回类型不匹配会在编译期报错。
 */
export function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return await handler(payload as IpcReq<C>);
    } catch (err) {
      // Electron 默认会把异常序列化成难读的字符串，这里统一成干净的消息
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[${channel}] ${message}`, { cause: err });
    }
  });
}

/** 主进程 → 所有渲染窗口的单向推送，用于流式输出与长任务进度 */
export function emit<C extends IpcEventChannel>(channel: C, payload: IpcEventMap[C]): void {
  for (const listener of eventListeners) {
    try {
      listener(channel, payload);
    } catch {
      // 单个订阅者失败不影响其它消费者
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
