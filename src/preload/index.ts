import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type IpcBridge,
  type IpcEventChannel,
  type IpcEventMap,
  type IpcInvokeChannel,
  type IpcReq,
  type IpcRes,
} from '@shared/ipc';

const invokeAllowList = new Set<string>(IPC_INVOKE_CHANNELS);
const eventAllowList = new Set<string>(IPC_EVENT_CHANNELS);

/**
 * 渲染进程唯一的对外出口。只放行 IpcInvokeMap / IpcEventMap 中登记过的通道，
 * 未登记的调用直接抛错，避免 UI 层绕过契约访问主进程能力。
 */
const bridge: IpcBridge = {
  invoke<C extends IpcInvokeChannel>(channel: C, payload: IpcReq<C>): Promise<IpcRes<C>> {
    if (!invokeAllowList.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload) as Promise<IpcRes<C>>;
  },

  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void {
    if (!eventAllowList.has(channel)) {
      throw new Error(`IPC event not allowed: ${channel}`);
    }
    const wrapped = (_event: unknown, payload: IpcEventMap[C]): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', bridge);
