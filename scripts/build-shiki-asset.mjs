/**
 * 生成软件工程包自带的**自包含 Shiki 构建**（IIFE，单文件）。
 *
 * 背景：插件页面被宿主内联进 `sandbox="allow-scripts"` 的 iframe 当普通 <script> 跑，
 * 没有网络、不能动态 import，所以不能像宿主渲染层那样走 `shiki` 主包（它靠惰性
 * import() 按需取语法 / 主题）。这里改用 fine-grained 入口：JS 正则引擎（不用
 * oniguruma WASM）+ 只登记查看器用得上的语言 + 双主题，全部打成一份扁平 IIFE，
 * 由包页面 `<script src="shiki.vendored.js">` 内联。
 *
 * 产物路径：plugins/softwareEngineering/desktop/ui/shiki.vendored.js
 *
 * 用法：node scripts/build-shiki-asset.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DESKTOP = join(ROOT, 'desktop');
const OUT_FILE = join(
  ROOT,
  'plugins/softwareEngineering/desktop/ui/shiki.vendored.js',
);

/**
 * 查看器按扩展名认得出的语言；与包页面 EXT_LANG 的取值基本对齐。
 *
 * 这里刻意不含 `cpp` 与 `ruby`：Shiki 的 C++ 语法（含 cpp-macro / glsl 依赖）与 Ruby 语法
 * 体量极大，连同别的语言一起远超单个代码资产 2,000,000 字符的上限（见 core 的
 * CODE_ASSET_MAX_LENGTH）。C++（.cc/.cpp/.hpp…）与 Ruby（.rb）因此退回纯等宽——页面在
 * `hasLanguage` 为假时原样转义，不假装有语法。其余 28 门语言都在，覆盖本查看器最常用的那批。
 */
const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'scala',
  'c',
  'csharp',
  'php',
  'swift',
  'lua',
  'shellscript',
  'sql',
  'json',
  'yaml',
  'toml',
  'xml',
  'html',
  'css',
  'markdown',
  'diff',
  'ini',
  'docker',
  'makefile',
];

const entry = `
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import themeLight from '@shikijs/themes/github-light-default';
import themeDark from '@shikijs/themes/github-dark-default';
${LANGS.map((id) => `import lang_${id.replace(/-/g, '_')} from '@shikijs/langs/${id}';`).join('\n')}

// 双主题：每个 token 上同时带 --shiki-light / --shiki-dark 两个变量，页面按主题取用，
// 切主题不必把已渲染的代码重新高亮一遍（与宿主渲染层 lib/highlight.ts 同一渲染方式）。
const THEMES = { light: 'github-light-default', dark: 'github-dark-default' };
const LANGS = {
${LANGS.map((id) => `  '${id}': lang_${id.replace(/-/g, '_')},`).join('\n')}
};

let corePromise = null;

function getCore() {
  // 语言一次全登记：它们彼此的 embeddedLangs 依赖必须同时在册，否则 shiki 会去动态 import
  // 一个不存在的模块（沙箱里没有网络、也不能动态 import）。全部内联，谁都不缺。
  corePromise ??= createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: Object.values(LANGS),
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return corePromise;
}

export function hasLanguage(lang) {
  return typeof lang === 'string' && Object.prototype.hasOwnProperty.call(LANGS, lang);
}

export async function highlight(code, lang, startLine) {
  if (!hasLanguage(lang)) return null;
  try {
    const core = await getCore();
    return core.codeToHtml(code, {
      lang,
      themes: THEMES,
      defaultColor: false,
      transformers: [
        {
          line(node, line) {
            node.properties['data-line'] = String((startLine || 1) + line - 1);
          },
        },
      ],
    });
  } catch {
    return null;
  }
}
`;

const result = await build({
  stdin: { contents: entry, resolveDir: DESKTOP, sourcefile: 'shiki-pack-entry.js' },
  bundle: true,
  format: 'iife',
  globalName: 'OpenJobShiki',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  banner: {
    js: [
      '/* Shiki self-contained build for the software-engineering code viewer (ui/repositories.html).',
      ' * Bundled from shiki + @shikijs/langs + @shikijs/themes (MIT) with the JS regex engine, both',
      ' * github-light-default / github-dark-default themes, and 28 inlined grammars. Everything resolves',
      ' * statically: no dynamic import, no oniguruma WASM, no network at runtime.',
      ' * Regenerate with `node scripts/build-shiki-asset.mjs` — do not edit by hand. */',
    ].join('\n'),
  },
  minify: true,
  charset: 'utf8',
  // vscode-textmate 会读 process.env.VSCODE_TEXTMATE_DEBUG 决定调试模式；这里在打包期把这一
  // 个成员表达式常量折叠掉（调试默认关），产物里因此不再出现 process.env——静态隔离扫描
  // 会拦 `process.env`，而沙箱里本就没有 process。这不是放宽扫描，是让产物真的不含它。
  define: { 'process.env.VSCODE_TEXTMATE_DEBUG': 'undefined' },
  write: false,
});
const out = result.outputFiles[0].text;
// 单个代码资产上限与 core 的 CODE_ASSET_MAX_LENGTH 一致：超了包就装不上，构建期就该失败
const CODE_ASSET_MAX_LENGTH = 2_000_000;
if (out.length > CODE_ASSET_MAX_LENGTH) {
  throw new Error(
    `Shiki 资产 ${out.length} 字符，超过代码资产上限 ${CODE_ASSET_MAX_LENGTH}；请再裁语言`,
  );
}
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, out, 'utf8');
console.log(`wrote ${OUT_FILE}  (${out.length} chars, ${Buffer.byteLength(out)} bytes)`);
