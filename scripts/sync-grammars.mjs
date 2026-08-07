import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 tree-sitter 语法文件从 node_modules 复制到 resources/tree-sitter，
 * 由 electron-builder 的 extraResources 带进安装包。
 *
 * 全量语法约 49MB，只挑面试常见的开源项目会用到的语言。
 * 没被收录的语言在运行时自动降级为正则提取，功能不断。
 */
const GRAMMARS = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'ruby',
  'php',
  'scala',
  'lua',
  'bash',
];

const require_ = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(projectRoot, 'resources', 'tree-sitter');

mkdirSync(outDir, { recursive: true });

let copied = 0;
let skipped = 0;
let bytes = 0;

for (const grammar of GRAMMARS) {
  const file = `tree-sitter-${grammar}.wasm`;
  let src;
  try {
    src = require_.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    console.warn(`[grammars] 缺少 ${file}，该语言将降级为正则提取`);
    skipped++;
    continue;
  }

  const dest = join(outDir, file);
  const srcStat = statSync(src);
  if (existsSync(dest) && statSync(dest).size === srcStat.size) {
    bytes += srcStat.size;
    continue;
  }

  copyFileSync(src, dest);
  copied++;
  bytes += srcStat.size;
}

console.log(
  `[grammars] ${GRAMMARS.length - skipped} 个语法就绪（新复制 ${copied} 个，` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB）→ resources/tree-sitter`,
);
