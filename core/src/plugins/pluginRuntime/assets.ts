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
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;
/** 页面自己样式/脚本的起点：注入样式插在它之前，页面规则依旧在后面、依旧能覆盖 */
const CONTENT_START_RE = /<(?:style|link|script)\b/i;

/**
 * 宿主交给页面的主题变量：变量名 → 值（如 `--color-surface` → `#f6f7f9`）。
 * 与任何一个岗位无关——页面在沙箱里拿不到宿主文档，继承不到应用 CSS，宿主只把
 * 「当前生效的那套自定义属性」原样递进去，页面自己决定用哪些。
 */
export type WebviewTheme = Readonly<Record<string, string>>;

/**
 * 把主题变量拼成一段 `:root{}` 规则。
 *
 * 变量名与值都收窄形状（名字须是 `--foo-bar`，值里不许出现 `}`/`;`/`<`/`>`），
 * 否则一个值里带 `}` 就能提前闭合规则、往页面里塞任意声明。空值直接跳过。
 */
function themeRootStyle(theme: WebviewTheme): string {
  const declarations = Object.entries(theme)
    .filter(([name, value]) => /^--[\w-]+$/.test(name) && value !== '' && !/[<>{};]/.test(value))
    .map(([name, value]) => `${name}:${value}`);
  if (declarations.length === 0) return '';
  return `<style data-openjob-theme>:root{${declarations.join(';')}}</style>`;
}

/**
 * 把注入样式放在页面自己内容**之前**。
 *
 * 注入的 `:root{}` 与页面自己的 `:root{}` 同优先级，级联里后面那条赢，所以先注入能让
 * 页面自己的规则照常覆盖同名的变量与声明——注入只补上页面没写的部分，不会反过来把
 * 页面自己的排版关掉。落点选在页面第一个 `<style>`/`<link>`/`<script>` 之前：既在页面
 * 样式之前，又不打断 `<meta charset>` 这类头部声明；没有这类标签就退回 `<head>` 之后，
 * 再没有就 `<html>` 之后，最后兜底放文档最前。
 */
function injectBeforeContent(html: string, tag: string): string {
  const content = CONTENT_START_RE.exec(html);
  if (content) {
    return html.slice(0, content.index) + tag + html.slice(content.index);
  }
  const head = HEAD_OPEN_RE.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const root = HTML_OPEN_RE.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

export function isRelativeAssetRef(ref: string): boolean {
  return !/^(https?:|data:|\/\/)/i.test(ref);
}

/**
 * 内联正文里的收尾序列要转义。
 *
 * 资产是原样内联进 `<script>`/`<style>` 的：正文里只要出现 `</script`，浏览器就在那里
 * 结束脚本，剩下的源码会变成文档正文被当文本渲染出来——页面看起来像"把源码打印了一遍"。
 * `<\/script` 在 JS 与 CSS 里都与原字面量等价（`\/` 就是 `/`），所以转义不改变语义。
 */
function escapeInlineBody(body: string, tag: 'script' | 'style'): string {
  return body.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
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
  theme?: WebviewTheme,
): string {
  let result = html;

  result = result.replace(SCRIPT_RE, (match, before: string, _raw: string, q1?: string, q2?: string, after?: string) => {
    const ref = (q1 ?? q2 ?? '').trim();
    if (!ref || !isRelativeAssetRef(ref)) return match;
    const path = resolvePath(entryPath, ref);
    if (path === null || assets[path] === undefined) return match;
    return `<script${before}${after}>${escapeInlineBody(assets[path], 'script')}</script>`;
  });

  result = result.replace(LINK_RE, (match, before: string, _raw: string, q1?: string, q2?: string) => {
    const rel = /\brel\s*=\s*("stylesheet"|'stylesheet')/i.test(before);
    if (!rel) return match;
    const ref = (q1 ?? q2 ?? '').trim();
    if (!ref || !isRelativeAssetRef(ref)) return match;
    const path = resolvePath(entryPath, ref);
    if (path === null || assets[path] === undefined) return match;
    return `<style>${escapeInlineBody(assets[path], 'style')}</style>`;
  });

  // 主题注入放在内联资产之后：资产替换只在原位改写 <script>/<link>，不改变页面文档顺序，
  // 所以这里按文档顺序找到页面第一个样式/脚本，把主题 <style> 插在它之前即可。
  if (theme) {
    const tag = themeRootStyle(theme);
    if (tag) result = injectBeforeContent(result, tag);
  }

  return result;
}
