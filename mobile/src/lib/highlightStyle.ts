import { getTheme } from '../theme';

function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  let h = match[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs! + 0.7152 * gs! + 0.0722 * bs!;
}

export function readableTextOnBackground(bg: string): string {
  const rgb = parseHexColor(bg);
  // 认不出高亮色时按正文色走：此时文字画在页面底色上，得跟着主题
  if (!rgb) return getTheme().text;
  const lum = relativeLuminance(rgb.r, rgb.g, rgb.b);
  return lum > 0.55 ? '#1a1a1a' : '#f5f5f5';
}

export function highlightTextStyle(bg: string): { backgroundColor: string; color: string } {
  return {
    backgroundColor: bg,
    color: readableTextOnBackground(bg),
  };
}
