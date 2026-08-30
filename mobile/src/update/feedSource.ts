/**
 * 手机端应用内更新的更新源解析。
 *
 * 桌面端在「设置 → 自动更新」里配的 feedUrl 会随 app_setting 同步到手机端，
 * 这里的规则与桌面 electron-updater 的 generic provider 完全一致（见
 * @shared/updateFeed 的 normalizeFeedUrl），手机端只是换成了「latest.yml
 * 取版本 + 按 CI 命名约定下载 OpenJob-<version>.apk」的消费方式。
 */

import { normalizeFeedUrl } from '@shared/updateFeed';

/**
 * 当前生效的 generic 目录；返回 null 表示没配置，走官方 GitHub Release。
 * 传空串、纯空白都算没配置——桌面端默认值就是空串。
 */
export function resolveFeedBase(feedUrl: string): string | null {
  const trimmed = feedUrl.trim();
  if (!trimmed) return null;
  return normalizeFeedUrl(trimmed);
}

/**
 * generic 源的落地页（iOS 装不了 APK 时给用户看的页面）。
 * GitHub 地址指回该仓库的发布页、镜像前缀原样保留；非 GitHub 地址
 * （自建目录）没有发布页可言，就用目录本身。
 */
export function genericPageUrl(base: string): string {
  const marker = base.toLowerCase().lastIndexOf('github.com/');
  if (marker < 0) return base;
  const prefix = base.slice(0, marker + 'github.com/'.length);
  const path = base
    .slice(prefix.length)
    .replace(/\/+$/, '')
    .replace(/\/releases\/latest\/download$/, '');
  const segments = path.split('/');
  if (segments.length !== 2 || segments.some((s) => s === '')) return base;
  return `${prefix}${segments[0]}/${segments[1]}/releases/latest`;
}