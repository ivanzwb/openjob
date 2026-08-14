import { useSyncExternalStore } from 'react';
import type { UiTheme } from '@shared/config';

/**
 * 当前主题。配色本身全由 CSS 变量在 html[data-theme] 上切换，
 * 这个 store 只服务少数几处颜色不由 CSS 决定的地方：
 * mermaid 的主题参数、React Flow 的 colorMode。
 */
/** 初值与默认主题一致；真实值由 initUiTheme 在 React 挂载前从 bootstrap 覆盖 */
let current: UiTheme = 'light';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setUiTheme(theme: UiTheme): void {
  if (theme === current) return;
  current = theme;
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

/** 在 React 挂载前调用：初值由主进程读 config.json 后经 preload 同步注入 */
export function initUiTheme(): void {
  current = window.bootstrap.theme;
  document.documentElement.dataset.theme = current;
}

export function useUiTheme(): UiTheme {
  return useSyncExternalStore(subscribe, () => current);
}
