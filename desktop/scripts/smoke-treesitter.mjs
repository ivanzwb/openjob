import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

/**
 * 校验 resources/tree-sitter 下的语法文件能被当前 web-tree-sitter 加载。
 *
 * 两者的 emscripten dylink 格式必须匹配：tree-sitter-wasms 的语法由
 * tree-sitter-cli 0.20 生成，web-tree-sitter 0.26+ 已经不认这个格式，
 * 所以 web-tree-sitter 锁在 0.25.x。升级任一方都先跑这个脚本。
 */

const require_ = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const grammarDir = join(projectRoot, 'resources', 'tree-sitter');

let runtimeWasm = null;
for (const subpath of ['web-tree-sitter/tree-sitter.wasm', 'web-tree-sitter/web-tree-sitter.wasm']) {
  try {
    runtimeWasm = require_.resolve(subpath);
    break;
  } catch {
    // 试下一个
  }
}
await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

const files = readdirSync(grammarDir).filter((f) => f.endsWith('.wasm'));
if (files.length === 0) {
  console.error('[smoke] resources/tree-sitter 为空，先跑 npm run sync:grammars');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const name = file.replace(/^tree-sitter-|\.wasm$/g, '');
  try {
    const lang = await Language.load(new Uint8Array(readFileSync(join(grammarDir, file))));
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse('func main() {}\nclass A {}\n');
    if (!tree) throw new Error('parse 返回 null');
    console.log(`  ok    ${name.padEnd(12)} → ${tree.rootNode.type}`);
    tree.delete();
    parser.delete();
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name.padEnd(12)} → ${err.message || err}`);
  }
}

console.log(`[smoke] ${files.length - failed}/${files.length} 个语法可加载`);
process.exit(failed > 0 ? 1 : 0);
