/**
 * Webview 资产的相对引用解析（§7.9 桥的资产切片）。
 *
 * 插件页面是 ui/ 下的 HTML，脚本与样式以相对路径引用同目录资产。信封里的
 * 资产是文本映射（无 HTTP 服务），所以桌面与移动端在渲染前调用本函数：
 * 把同包可解析的相对引用改写为内联标签，外部 URL 与无法解析的引用原样保留——
 * 交给沙箱（无网络权限的 iframe 天然加载失败）而不是在这里猜。
 */

const SCRIPT_RE = /<script\b([^>]*?)\bsrc\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>\s*<\/script>/gi;
const LINK_RE = /<link\b([^>]*?)\bhref\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>/gi;

export function isRelativeAssetRef(ref: string): boolean {
  return !/^(https?:|data:|\/\/)/i.test(ref);
}

/** 相对 entryPath 所在目录解析 ref；越出 ui/ 顶层（..）视为不可解析 */
function resolvePath(entryPath: string, ref: string): string | null {
  if (!isRelativeAssetRef(ref)) return null;
  const dir = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
  const parts = (dir + ref).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0 || out[out.length - 1] === '') return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

export function resolveWebviewHtml(
  entryPath: string,
  html: string,
  assets: Readonly<Record<string, string>>,
): string {
  let result = html;

  result = result.replace(SCRIPT_RE, (match, before: string, _raw: string, q1?: string, q2?: string, after?: string) => {
    const ref = (q1 ?? q2 ?? '').trim();
    if (!ref || !isRelativeAssetRef(ref)) return match;
    const path = resolvePath(entryPath, ref);
    if (path === null || assets[path] === undefined) return match;
    return `<script${before}${after}>${assets[path]}</script>`;
  });

  result = result.replace(LINK_RE, (match, before: string, _raw: string, q1?: string, q2?: string) => {
    const rel = /\brel\s*=\s*("stylesheet"|'stylesheet')/i.test(before);
    if (!rel) return match;
    const ref = (q1 ?? q2 ?? '').trim();
    if (!ref || !isRelativeAssetRef(ref)) return match;
    const path = resolvePath(entryPath, ref);
    if (path === null || assets[path] === undefined) return match;
    return `<style>${assets[path]}</style>`;
  });

  return result;
}
