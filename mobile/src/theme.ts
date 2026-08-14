import { useSyncExternalStore } from 'react';

export type ThemeScheme = 'dark' | 'light';

/** 语义色三元组：前景色 / 描边 / 着色底板 */
interface Tone {
  text: string;
  border: string;
  bg: string;
}

export interface Palette {
  scheme: ThemeScheme;
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  success: string;
  danger: string;
  /** 模态遮罩。两套主题都压暗：遮罩上盖的是白纸、相机画面和白字按钮 */
  scrim: string;
  /**
   * 带语义的着色块（来源标签、Toast、批注）。深色下前景取浅色阶、底板取深色阶，
   * 浅色主题把两头翻过来，用色的地方不必关心当前是哪套主题。
   */
  tone: Record<'amber' | 'sky' | 'emerald' | 'red' | 'slate', Tone>;
}

const DARK: Palette = {
  scheme: 'dark',
  bg: '#0b0d12',
  surface: '#12151c',
  border: '#374151',
  text: '#f3f4f6',
  muted: '#9ca3af',
  accent: '#4f7cff',
  success: '#a7f3d0',
  danger: '#fca5a5',
  scrim: 'rgba(0, 0, 0, 0.45)',
  tone: {
    amber: { text: '#fcd34d', border: '#92400e', bg: '#451a03' },
    sky: { text: '#7dd3fc', border: '#0369a1', bg: '#082f49' },
    emerald: { text: '#6ee7b7', border: '#065f46', bg: '#052e16' },
    red: { text: '#fca5a5', border: '#991b1b', bg: '#450a0a' },
    slate: { text: '#f3f4f6', border: '#374151', bg: '#1f2937' },
  },
};

const LIGHT: Palette = {
  scheme: 'light',
  bg: '#ffffff',
  surface: '#f6f7f9',
  border: '#dfe3ea',
  text: '#16181d',
  muted: '#616a7d',
  accent: '#2f5cd8',
  success: '#047857',
  danger: '#b91c1c',
  scrim: 'rgba(0, 0, 0, 0.45)',
  tone: {
    amber: { text: '#92400e', border: '#fcd34d', bg: '#fef3c7' },
    sky: { text: '#075985', border: '#7dd3fc', bg: '#e0f2fe' },
    emerald: { text: '#065f46', border: '#6ee7b7', bg: '#d1fae5' },
    red: { text: '#991b1b', border: '#fca5a5', bg: '#fee2e2' },
    slate: { text: '#16181d', border: '#dfe3ea', bg: '#f1f5f9' },
  },
};

const PALETTES: Record<ThemeScheme, Palette> = { dark: DARK, light: LIGHT };

/**
 * 初值取浅色，与 DEFAULT_CONFIG.ui.theme 一致：全新安装还没同步到桌面配置时，
 * 首帧就该是浅色，否则配对前后会闪一次主题。
 */
let current: Palette = LIGHT;
const listeners = new Set<() => void>();

/** 主题跟着桌面走：由同步下来的 app_setting.ui.theme 决定，本机不另存一份 */
export function setThemeScheme(scheme: ThemeScheme): void {
  if (scheme === current.scheme) return;
  current = PALETTES[scheme];
  for (const listener of listeners) listener();
}

/** 渲染路径之外的纯函数用这个；组件里一律用 useTheme，否则切主题不会重渲染 */
export function getTheme(): Palette {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Palette {
  return useSyncExternalStore(subscribe, getTheme);
}
