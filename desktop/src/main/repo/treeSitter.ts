import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Language, Node, Parser } from 'web-tree-sitter';

/**
 * tree-sitter 符号提取。语法文件按需加载，任何一步失败都返回 null，
 * 由调用方降级到正则提取——设计要求「没有 parser 的语言优雅降级，功能不断」。
 *
 * web-tree-sitter 锁在 0.25.x：tree-sitter-wasms 的语法由 cli 0.20 生成，
 * 0.26 起的 emscripten 不再认这个 dylink 格式，加载会直接抛错。
 * 升级前先跑 scripts/smoke-treesitter.mjs。
 */

const require_ = createRequire(import.meta.url);

/** 扩展名 → tree-sitter-wasms 里的语法名 */
const GRAMMAR_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
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
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.lua': 'lua',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.zig': 'zig',
  '.sh': 'bash',
  '.vue': 'vue',
};

/**
 * 声明节点类型 → 展示用的 kind。
 * 各语法的节点类型名基本不冲突，一张全局表比按语言分表好维护。
 */
const KIND_BY_TYPE: Record<string, string> = {
  function_declaration: 'fn',
  generator_function_declaration: 'fn',
  function_definition: 'fn',
  function_item: 'fn',
  method_declaration: 'method',
  method_definition: 'method',
  method: 'method',
  constructor_declaration: 'method',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  class_definition: 'class',
  class_specifier: 'class',
  class: 'class',
  object_declaration: 'object',
  module: 'module',
  interface_declaration: 'interface',
  protocol_declaration: 'interface',
  trait_item: 'trait',
  impl_item: 'impl',
  struct_item: 'struct',
  struct_specifier: 'struct',
  enum_item: 'enum',
  enum_declaration: 'enum',
  enum_specifier: 'enum',
  type_alias_declaration: 'type',
  // Go 的 type_declaration 只是壳子，名字挂在内层 type_spec 上
  type_spec: 'type',
};

/** 只有值是函数/类时才算符号，否则 `const x = 1` 会淹没结果 */
const CALLABLE_VALUE_TYPES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'generator_function',
  'class',
]);

export interface SymbolHit {
  name: string;
  kind: string;
  line: number;
}

interface Runtime {
  ParserCtor: typeof Parser;
  LanguageCtor: typeof Language;
  languages: Map<string, Language | null>;
}

let runtimePromise: Promise<Runtime | null> | null = null;
let usedAst = false;

function grammarDirs(): string[] {
  const dirs: string[] = [];
  // 打包后 extraResources 把 resources/ 铺到 resourcesPath 根下
  if (process.resourcesPath) dirs.push(join(process.resourcesPath, 'tree-sitter'));
  dirs.push(join(process.cwd(), 'resources', 'tree-sitter'));
  return dirs;
}

function resolveGrammarPath(grammar: string): string | null {
  const file = `tree-sitter-${grammar}.wasm`;
  for (const dir of grammarDirs()) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  try {
    return require_.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    return null;
  }
}

async function getRuntime(): Promise<Runtime | null> {
  runtimePromise ??= (async (): Promise<Runtime | null> => {
    try {
      const { Parser: ParserCtor, Language: LanguageCtor } = await import('web-tree-sitter');
      // 运行时 wasm 的文件名在 0.25 与 0.26 之间改过，两个都试
      let runtimeWasm: string | null = null;
      for (const subpath of ['web-tree-sitter/tree-sitter.wasm', 'web-tree-sitter/web-tree-sitter.wasm']) {
        try {
          runtimeWasm = require_.resolve(subpath);
          break;
        } catch {
          // 换下一个候选，都失败就交给 emscripten 自己找
        }
      }
      await ParserCtor.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);
      return { ParserCtor, LanguageCtor, languages: new Map() };
    } catch {
      return null;
    }
  })();

  return runtimePromise;
}

async function getLanguage(rt: Runtime, grammar: string): Promise<Language | null> {
  const cached = rt.languages.get(grammar);
  if (cached !== undefined) return cached;

  let lang: Language | null = null;
  const path = resolveGrammarPath(grammar);
  if (path) {
    try {
      lang = await rt.LanguageCtor.load(new Uint8Array(readFileSync(path)));
    } catch {
      lang = null;
    }
  }
  rt.languages.set(grammar, lang);
  return lang;
}

function findIdentifier(node: Node, depth = 0): string | null {
  if (depth > 4) return null;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type.endsWith('identifier')) return child.text;
    // C/C++ 的名字埋在 declarator 链里
    if (child.type.endsWith('declarator')) {
      const inner = findIdentifier(child, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

function symbolName(node: Node): string | null {
  const named = node.childForFieldName('name');
  if (named?.text) return named.text;

  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    if (declarator.type.endsWith('identifier')) return declarator.text;
    const inner = findIdentifier(declarator);
    if (inner) return inner;
  }

  const typeField = node.childForFieldName('type');
  if (typeField?.type.endsWith('identifier')) return typeField.text;

  return findIdentifier(node);
}

function collect(root: Node, limit: number): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const stack: Node[] = [root];

  while (stack.length > 0 && hits.length < limit) {
    const node = stack.pop();
    if (!node) continue;

    const kind = KIND_BY_TYPE[node.type];
    if (kind) {
      const name = symbolName(node);
      if (name) hits.push({ name, kind, line: node.startPosition.row + 1 });
    } else if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      if (value && CALLABLE_VALUE_TYPES.has(value.type)) {
        const name = symbolName(node);
        if (name) hits.push({ name, kind: 'fn', line: node.startPosition.row + 1 });
      }
    }

    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }

  hits.sort((a, b) => a.line - b.line);
  return hits;
}

/**
 * AST 提取符号。语法不支持、wasm 缺失或解析异常时返回 null，
 * 调用方据此降级到正则。
 */
export async function extractSymbolsAst(
  source: string,
  ext: string,
  limit = 30,
): Promise<SymbolHit[] | null> {
  const grammar = GRAMMAR_BY_EXT[ext];
  if (!grammar) return null;

  const rt = await getRuntime();
  if (!rt) return null;

  const lang = await getLanguage(rt, grammar);
  if (!lang) return null;

  const parser = new rt.ParserCtor();
  try {
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (!tree) return null;
    try {
      usedAst = true;
      return collect(tree.rootNode, limit);
    } finally {
      tree.delete();
    }
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}

/** 本次进程内是否至少成功用过一次 AST 解析，用于在 repo map 里标注来源 */
export function astWasUsed(): boolean {
  return usedAst;
}
