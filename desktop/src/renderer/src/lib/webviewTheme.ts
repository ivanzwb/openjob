import type { UiTheme } from '@core/config';
import type { WebviewTheme } from '@core/plugins/pluginRuntime/assets';

/**
 * 插件页面在沙箱 iframe 里有自己的文档，继承不到应用 CSS，所以宿主把当前生效的
 * 主题自定义属性读出来递进去（见 core pluginRuntime/assets 的注入）。这份名单是
 * **角色中立的通用色板**：六个语义 token 加页面排版会用到的几档调色板色阶，
 * 与任何岗位、任何页面用途都无关——谁需要谁在自己的页面里取用。
 *
 * 语义 token 之外还带上调色板档位（emerald / sky / amber / red），因为应用在浅色主题
 * 下把这几个档位整体翻过（见 renderer/index.css），直接注入才能让页面和应用同色。
 */
const THEME_TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-border',
  '--color-fg',
  '--color-muted',
  '--color-accent',
  '--color-emerald-300',
  '--color-emerald-400',
  '--color-emerald-800',
  '--color-emerald-950',
  '--color-sky-300',
  '--color-sky-400',
  '--color-sky-800',
  '--color-sky-950',
  '--color-amber-300',
  '--color-amber-900',
  '--color-amber-950',
  '--color-red-300',
  '--color-red-400',
  '--color-red-900',
  '--color-red-950',
] as const;

/**
 * 读当前生效的主题变量。
 *
 * 用 `getComputedStyle` 而不是硬编码两套色：浅色由 `html:not([data-theme='dark'])`
 * 覆盖、深色走编译基线，只有文档当前算出来的值才是页面上真正在用的那套。
 * 变量没定义就直接跳过，页面用自己的兜底色。
 */
export function readWebviewTheme(theme: UiTheme): WebviewTheme {
  const values: Record<string, string> = {};
  if (typeof document === 'undefined') return values;
  const computed = getComputedStyle(document.documentElement);
  for (const name of THEME_TOKENS) {
    const value = computed.getPropertyValue(name).trim();
    if (value) values[name] = value;
  }
  // Shiki 输出双主题（每个 token 带 --shiki-light / --shiki-dark），页面得知道现在该取哪套。
  // 沙箱里 prefers-color-scheme 跟的是操作系统，不是应用主题，所以由宿主把这个选择告诉页面。
  values['--oj-color-scheme'] = theme;
  return values;
}
