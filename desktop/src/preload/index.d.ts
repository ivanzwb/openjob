import type { IpcBridge, RendererBootstrap } from '@core/ipc';

declare global {
  interface Window {
    api: IpcBridge;
    bootstrap: RendererBootstrap;
  }
}

export {};
