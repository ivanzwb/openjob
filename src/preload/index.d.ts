import type { IpcBridge, RendererBootstrap } from '@shared/ipc';

declare global {
  interface Window {
    api: IpcBridge;
    bootstrap: RendererBootstrap;
  }
}

export {};
