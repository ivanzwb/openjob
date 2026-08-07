import type {
  IpcEventChannel,
  IpcEventMap,
  IpcInvokeChannel,
  IpcReq,
  IpcRes,
} from '@shared/ipc';

/** 渲染进程访问主进程的唯一入口，类型由 IpcInvokeMap 约束 */
export function invoke<C extends IpcInvokeChannel>(
  channel: C,
  payload: IpcReq<C>,
): Promise<IpcRes<C>> {
  return window.api.invoke(channel, payload);
}

export function onEvent<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventMap[C]) => void,
): () => void {
  return window.api.on(channel, listener);
}
