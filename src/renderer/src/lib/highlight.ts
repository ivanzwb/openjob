import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Shiki 高亮器。
 *
 * 用 fine-grained 引入而不是 `shiki` 主包：主包把两百多门语言做成惰性 import，
 * Vite 会为此切出同样数量的 chunk。这里只按扩展名注册用得上的语言。
 * 正则引擎选 JS 版而非 oniguruma，省掉一个 ~500KB 的 wasm。
 */

/** 扩展名 → shiki 语言 id */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.lua': 'lua',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.sql': 'sql',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.md': 'markdown',
};

const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  swift: () => import('@shikijs/langs/swift'),
  scala: () => import('@shikijs/langs/scala'),
  lua: () => import('@shikijs/langs/lua'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  xml: () => import('@shikijs/langs/xml'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  markdown: () => import('@shikijs/langs/markdown'),
};

export const THEME = 'github-dark-default';

let corePromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function getCore(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-dark-default')],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return corePromise;
}

/** 由文件路径推断 shiki 语言 id，未知语言返回 null */
export function langForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return LANG_BY_EXT[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * 高亮成 HTML。语言未知或加载失败时返回 null，调用方渲染纯文本。
 * startLine 用于让行号从文件真实位置开始，而不是从 1 开始。
 */
export async function highlightToHtml(
  code: string,
  lang: string | null,
  startLine: number,
): Promise<string | null> {
  if (!lang) return null;
  const loader = LANG_LOADERS[lang];
  if (!loader) return null;

  try {
    const core = await getCore();
    if (!loaded.has(lang)) {
      await core.loadLanguage((await loader()) as Parameters<typeof core.loadLanguage>[0]);
      loaded.add(lang);
    }
    return core.codeToHtml(code, {
      lang,
      theme: THEME,
      transformers: [
        {
          line(node, line) {
            node.properties['data-line'] = String(startLine + line - 1);
          },
        },
      ],
    });
  } catch {
    return null;
  }
}
