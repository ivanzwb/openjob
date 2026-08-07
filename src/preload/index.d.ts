import type { IpcBridge } from '@shared/ipc';

declare global {
  interface Window {
    api: IpcBridge;
  }
}

export {};
