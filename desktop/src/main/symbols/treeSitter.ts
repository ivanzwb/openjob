/**
 * tree-sitter 符号提取：宿主侧的通用引擎。
 *
 * 住在符号层而不是岗位层——扩展名映射、节点类型映射、AST 遍历都只认语言、不认岗位，
 * 调用方是工作区原语（`workspace.symbols`）与源码能力自己。语法文件按需加载，任何一步
 * 失败都返回 null，由调用方降级到正则（设计要求「没有 parser 的语言优雅降级，功能不断」）。
 *
 * **进程级常驻**：`Parser.init` 与每个 grammar 的 wasm 编译都是一次性成本（14 个 grammar
 * 合计约 0.8 s，冷启动最差 7.7 s，且单次最慢的 grammar 往往换人），所以 Parser 与 Language
 * 都挂在 Runtime 上复用，不再每次调用新建再销毁。同一 grammar 的首次载入也做了并发去重。
 *
 * web-tree-sitter 锁在 0.25.x：tree-sitter-wasms 的语法由 cli 0.20 生成，
 * 0.26 起的 emscripten 不再认这个 dylink 格式，加载会直接抛错。
 * 升级前先跑 desktop/scripts/smoke-treesitter.mjs。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language, Node, Parser } from 'web-tree-sitter';
import type { WorkspaceSymbolKind } from '@core/plugins/pluginRuntime/host';

const require_ = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));

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
 * 声明节点类型 → 展示用的 kind。**闭集合**：这里的值域就是原语对外承诺的 kind 全集，
 * 各语法的节点类型名基本不冲突，一张全局表比按语言分表好维护。要加语言或加 kind，
 * 改这里并同步契约（core/src/plugins/pluginRuntime/host.ts 的 WORKSPACE_SYMBOL_KINDS）。
 */
const KIND_BY_TYPE: Record<string, WorkspaceSymbolKind> = {
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
  kind: WorkspaceSymbolKind;
  /** 1 起行号 */
  line: number;
  /** 1 起行号；与 line 相同表示单行声明 */
  endLine: number;
  /** 外层符号名链，从最外层到直接父级；顶层符号为空数组 */
  containerPath: string[];
}

export interface SymbolExtraction {
  symbols: SymbolHit[];
  /** 触到条数上限、后面还有符号没取时为 true（调用方据此决定是否收窄范围再来） */
  truncated: boolean;
}

interface Runtime {
  ParserCtor: typeof Parser;
  LanguageCtor: typeof Language;
  /** 每 grammar 缓存，含 null 负缓存 */
  languages: Map<string, Language | null>;
  /** 同一 grammar 首次载入的去重：并发的批量调用不重复读盘与编译 */
  loading: Map<string, Promise<Language | null>>;
  /** 常驻 Parser：批量提取时同一个实例反复用 */
  parser: Parser;
  /** 当前 Parser 上已经设置过的 grammar，相同就跳过 setLanguage */
  parserGrammar: string | null;
}

let runtimePromise: Promise<Runtime | null> | null = null;
let usedAst = false;

/**
 * 语法文件所在目录，按可信度排序。
 *
 * 打包后 extraResources 把 resources/ 铺到 resourcesPath 根下；开发态与单测里从模块位置
 * 回溯（源码布局与 electron-vite 的 out/ 布局深度不同，所以三个深度都试）；最后保留历史上
 * 的 cwd 兜底，脚本与非标准启动方式仍然命中。
 */
function grammarDirs(): string[] {
  const dirs: string[] = [];
  if (process.resourcesPath) dirs.push(join(process.resourcesPath, 'tree-sitter'));
  for (const up of ['..', '../..', '../../..']) {
    dirs.push(join(moduleDir, up, 'resources', 'tree-sitter'));
  }
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
      return {
        ParserCtor,
        LanguageCtor,
        languages: new Map(),
        loading: new Map(),
        parser: new ParserCtor(),
        parserGrammar: null,
      };
    } catch {
      return null;
    }
  })();

  return runtimePromise;
}

async function getLanguage(rt: Runtime, grammar: string): Promise<Language | null> {
  const cached = rt.languages.get(grammar);
  if (cached !== undefined) return cached;

  const inflight = rt.loading.get(grammar);
  if (inflight) return inflight;

  const task = (async (): Promise<Language | null> => {
    const path = resolveGrammarPath(grammar);
    if (!path) return null;
    try {
      return await rt.LanguageCtor.load(new Uint8Array(readFileSync(path)));
    } catch {
      return null;
    }
  })().then((lang) => {
    rt.languages.set(grammar, lang);
    rt.loading.delete(grammar);
    return lang;
  });

  rt.loading.set(grammar, task);
  return task;
}

/**
 * 丢掉当前 Parser 重建一个。
 *
 * 常驻实例的风险是「脏了就一直是脏的」：setLanguage 失败或 wasm 崩过之后，后续调用都该拿到
 * 一个干净实例，而不是一路失败到进程重启。
 */
function resetParser(rt: Runtime): void {
  try {
    rt.parser.delete();
  } catch {
    // 已经废了，删不掉也无所谓
  }
  try {
    rt.parser = new rt.ParserCtor();
  } catch {
    // 重建都失败时留给下一次调用再试
  }
  rt.parserGrammar = null;
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

/** 这个节点是不是符号；是的话返回 kind。 */
function symbolKind(node: Node): WorkspaceSymbolKind | null {
  const kind = KIND_BY_TYPE[node.type];
  if (kind) return kind;
  if (node.type !== 'variable_declarator') return null;
  const value = node.childForFieldName('value');
  return value && CALLABLE_VALUE_TYPES.has(value.type) ? 'fn' : null;
}

/**
 * 显式栈 DFS 收集符号。
 *
 * 栈里带上「此刻的外层符号链」，所以 containerPath 是遍历的自然产物，不用回查父节点；
 * 命中的符号自己也会成为后续子节点的外层（类里的方法、方法里嵌套的函数）。
 */
function collect(root: Node, limit: number): SymbolExtraction {
  const symbols: SymbolHit[] = [];
  const stack: Array<{ node: Node; containers: readonly string[] }> = [
    { node: root, containers: [] },
  ];
  let truncated = false;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    let containers = frame.containers;

    const kind = symbolKind(node);
    if (kind) {
      const name = symbolName(node);
      if (name) {
        if (symbols.length >= limit) {
          // 到上限时又撞见一个符号：说明后面还有，如实标出来
          truncated = true;
          break;
        }
        symbols.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          containerPath: [...containers],
        });
        containers = [...containers, name];
      }
    }

    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push({ node: child, containers });
    }
  }

  symbols.sort((a, b) => a.line - b.line);
  return { symbols, truncated };
}

/** 扩展名对应的语法名；没有对应语法时 null（调用方表现为「语言未知」，不是错误） */
export function grammarForExt(ext: string): string | null {
  return GRAMMAR_BY_EXT[ext] ?? null;
}

/**
 * AST 提取符号。语法不支持、wasm 缺失或解析异常时返回 null，调用方据此降级到正则。
 */
export async function extractSymbolsAst(
  source: string,
  ext: string,
  limit = 30,
): Promise<SymbolExtraction | null> {
  const grammar = GRAMMAR_BY_EXT[ext];
  if (!grammar) return null;

  const rt = await getRuntime();
  if (!rt) return null;

  const lang = await getLanguage(rt, grammar);
  if (!lang) return null;

  try {
    if (rt.parserGrammar !== grammar) {
      rt.parser.setLanguage(lang);
      rt.parserGrammar = grammar;
    }
    const tree = rt.parser.parse(source);
    if (!tree) return null;
    try {
      usedAst = true;
      return collect(tree.rootNode, limit);
    } finally {
      tree.delete();
    }
  } catch {
    resetParser(rt);
    return null;
  }
}

/** 本次进程内是否至少成功用过一次 AST 解析，用于在符号地图里标注来源 */
export function astWasUsed(): boolean {
  return usedAst;
}
