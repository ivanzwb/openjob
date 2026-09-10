/**
 * 更新源的共享逻辑：桌面端 electron-updater 与手机端应用内更新共用同一套
 * 「填 URL → 规整成 generic provider 产物目录」的规则。逻辑放在共享层，
 * 两端才不会出现桌面按「GitHub 仓库地址」解析、手机端却按「自建目录」解析
 * 这种分叉。
 */

/** GitHub 把最新一版的资产挂在这个相对路径下，latest.yml 也在里面 */
export const GITHUB_ASSET_PATH = 'releases/latest/download';

/**
 * 把用户填的更新源规整成 generic provider 的产物目录。
 *
 * generic provider 只会把 latest.yml 接在这个 URL 后面（newBaseUrl 先补尾斜杠，
 * 再 new URL('latest.yml', base)），所以填一个 GitHub 仓库地址就会去请求仓库根下的
 * latest.yml——那不是真实资产路径，GitHub 直接 404，套了 gh-proxy 这类镜像则是挂到
 * 超时后回 522。资产实际在 releases/latest/download 下，这里替用户补上，
 * 镜像前缀（https://gh-proxy.org/https://github.com/...）原样保留。
 *
 * 只补「光秃秃的 owner/repo」这一种：已经写明具体路径的按用户填的走，不去猜。
 * 手机端复用同一规则：CI 把 APK 命名成 OpenJob-<version>.apk 挂在同一个发布
 * 目录下，所以「填 GitHub 仓库地址 → 指向 releases/latest/download」对两端都成立。
 */
export function normalizeFeedUrl(raw: string): string {
  const url = raw.trim();
  const marker = url.toLowerCase().lastIndexOf('github.com/');
  if (marker < 0) return url;

  const prefix = url.slice(0, marker + 'github.com/'.length);
  const path = url
    .slice(prefix.length)
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const segments = path.split('/');
  if (segments.length !== 2 || segments.some((s) => s === '')) return url;

  return `${prefix}${path}/${GITHUB_ASSET_PATH}`;
}