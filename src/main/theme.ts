import type { BrowserWindow } from 'electron';
import type { UiTheme } from '@shared/config';

/**
 * 窗口底色，必须与渲染层的 --color-bg 一致：
 * 建窗到首帧之间、以及拖拽缩放露出的新区域，画的都是这个颜色。
 * 索引由 config.ui.theme 给出，缺省即默认的 light。
 */
export const WINDOW_BACKGROUND: Record<UiTheme, string> = {
  light: '#ffffff',
  dark: '#0b0d12',
};

let mainWindow: BrowserWindow | null = null;

export function trackWindowTheme(win: BrowserWindow): void {
  mainWindow = win;
}

/** 主题切换后立刻跟上，避免下次缩放窗口时闪出上一套底色 */
export function applyWindowTheme(theme: UiTheme): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(WINDOW_BACKGROUND[theme]);
  }
}
