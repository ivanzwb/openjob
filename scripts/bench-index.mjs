/**
 * 仓库索引 / 符号提取性能基准（只测量，不改产品代码）。
 *
 * 复用**真实实现**（这三个模块都不 import electron，用 vite 的 ssrLoadModule 加载，
 * 别名姿势与 scripts/pack-plugins.mjs 一致）：
 *   - desktop/src/main/repo/treeSitter.ts     → extractSymbolsAst（wasm 加载 + tree-sitter 解析 + 提符号）
 *   - desktop/src/main/repo/files.ts          → listAllFilesAsync（枚举）
 *   - desktop/src/renderer/src/ipc/index.ts   → invoke（跨沙箱调用固定成本，配 mock 网关）
 *
 * 注意：现有的「全量索引」在仓库里并不存在——buildRepoMapAsync 上限 80 文件 / depth≤4，
 * 符号索引也不落盘（repository.ts 注释：find_symbol/glob/grep 查询时现扫磁盘）。所以
 * 「全量索引」这一档由基准脚本按真实链路拼装：枚举 → 读 → sha256 → extractSymbolsAst。
 *
 * 缺口：真实跨进程（Electron ipcRenderer.invoke ↔ ipcMain.handle）那一跳量不到，见报告。
 *
 * 用法：
 *   node scripts/bench-index.mjs [--keep]
 *   --keep   保留生成的 fixture（默认跑完删除；fixture 落在会话 scratchpad / 临时目录，不进仓库）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'desktop');
const KEEP = process.argv.includes('--keep');

// ─────────────────────────── fixture 生成 ───────────────────────────

// 语言配比：TS/TSX 为主，其余按 resources/tree-sitter 下可用的 14 个语法铺开
const LANG_MIX = [
  ['.ts', 42], ['.tsx', 20], ['.js', 5], ['.py', 6], ['.go', 4], ['.rs', 4],
  ['.java', 4], ['.c', 2], ['.cpp', 3], ['.rb', 2], ['.php', 2], ['.lua', 1],
  ['.scala', 1], ['.sh', 1],
];
const LANG_NAME = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.py': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.scala': 'scala', '.sh': 'bash',
};
// 14 个扩展各取一个代表，用于「加载全部 grammar」的冷启动测量
const REP_EXTS = LANG_MIX.map(([ext]) => ext);

const GEN = {
  '.ts': {
    header: "import { useState } from 'react';\n",
    decl: (n) => `export function compute${n}(input: string, count: number): string {\n  const parts = input.split(',');\n  let total = count;\n  for (const part of parts) { total += part.length; }\n  return parts.slice(0, total).join('|');\n}\n\nexport interface Widget${n} { id: string; size: number; }\n\nexport class Service${n} {\n  private cache = new Map<string, number>();\n  compute(key: string): number { return this.cache.get(key) ?? key.length; }\n}\n`,
  },
  '.tsx': {
    header: "import { useState } from 'react';\n",
    decl: (n) => `export function Panel${n}(props: { title: string }) {\n  return <div className="panel"><span>{props.title}</span></div>;\n}\n\nexport const useThing${n} = () => {\n  const [n, setN] = useState(${n});\n  return { n, setN };\n};\n`,
  },
  '.js': {
    header: "'use strict';\n",
    decl: (n) => `export function benchFn${n}(x) {\n  return x + ${n};\n}\n\nexport const benchConst${n} = () => ${n};\n\nexport class Bench${n} {\n  call(x) { return x; }\n}\n`,
  },
  '.py': {
    header: 'from dataclasses import dataclass\n',
    decl: (n) => `def bench_fn_${n}(x):\n    total = x + ${n}\n    return total\n\n\nclass Bench${n}:\n    def call(self, x):\n        return x\n`,
  },
  '.go': {
    header: 'package bench\n',
    decl: (n) => `func BenchFn${n}(x int) int {\n\treturn x + ${n}\n}\n\ntype Bench${n} struct {\n\tID   int\n\tName string\n}\n`,
  },
  '.rs': {
    header: 'use std::collections::HashMap;\n',
    decl: (n) => `pub fn bench_fn_${n}(x: i32) -> i32 {\n    x + ${n}\n}\n\npub struct Bench${n} {\n    id: i32,\n}\n\nimpl Bench${n} {\n    pub fn new() -> Self { Self { id: ${n} } }\n}\n`,
  },
  '.java': {
    header: 'package bench;\n',
    decl: (n) => `public class Bench${n} {\n  private int id;\n  public int call(int x) { return x + ${n}; }\n  public String name() { return "b${n}"; }\n}\n`,
  },
  '.c': {
    header: '#include <stdio.h>\n',
    decl: (n) => `int bench_fn_${n}(int x) {\n  return x + ${n};\n}\n`,
  },
  '.cpp': {
    header: '#include <string>\n',
    decl: (n) => `class Bench${n} {\n public:\n  int call(int x) { return x + ${n}; }\n};\n\nint bench_fn_${n}(int x) {\n  return x + ${n};\n}\n`,
  },
  '.rb': {
    header: '# frozen_string_literal: true\n',
    decl: (n) => `def bench_fn_${n}(x)\n  x.to_s\nend\n\nclass Bench${n}\n  def call\n    ${n}\n  end\nend\n`,
  },
  '.php': {
    header: '<?php\n',
    decl: (n) => `function bench_fn_${n}($x) {\n  return $x + ${n};\n}\n\nclass Bench${n} {\n  public function call() { return ${n}; }\n}\n`,
  },
  '.lua': {
    header: 'local bench = {}\n',
    decl: (n) => `function bench_fn_${n}(x)\n  return x + ${n}\nend\n\nfunction bench.value_${n}()\n  return ${n}\nend\n`,
  },
  '.scala': {
    header: 'package bench\n',
    decl: (n) => `class Bench${n} {\n  def call(x: Int): Int = x + ${n}\n}\n\nobject BenchObj${n} {\n  val id: Int = ${n}\n}\n`,
  },
  '.sh': {
    header: '#!/usr/bin/env bash\n',
    decl: (n) => `bench_fn_${n}() {\n  local x="$1"\n  echo "$x"\n}\n`,
  },
};

const FILLER = (n) => Array.from({ length: 6 }, (_, k) => `// filler ${n}-${k} generated repo fixture line`).join('\n') + '\n';

// 确定性 LCG，保证可复现
function rngFrom(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function pickExt(rng) {
  const total = LANG_MIX.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [ext, w] of LANG_MIX) {
    if ((r -= w) <= 0) return ext;
  }
  return '.ts';
}

function makeFile(ext, rng, targetBytes) {
  const g = GEN[ext];
  let out = g.header;
  let i = 0;
  while (Buffer.byteLength(out, 'utf8') < targetBytes) {
    out += g.decl(i++) + '\n';
    if (i % 3 === 0) out += FILLER(i) + '\n';
  }
  return out;
}

/** 生成一档 fixture，返回 { root, files: [{rel, abs, ext, lang, size}] } */
function buildFixture(root, { count, largeCount }) {
  mkdirSync(root, { recursive: true });
  const rng = rngFrom(count * 2654435761 + 7);
  const dirs = new Set();
  const files = [];

  for (let i = 0; i < count; i++) {
    const ext = pickExt(rng);
    const dir = join('src', `pkg${i % 10}`, `mod${i % 17}`);
    const rel = `${dir.replace(/\\/g, '/')}/file_${i}${ext}`;
    const abs = join(root, rel);
    if (!dirs.has(dir)) {
      mkdirSync(join(root, dir), { recursive: true });
      dirs.add(dir);
    }
    const target = 1024 + Math.floor(rng() * (8192 - 1024)); // 1–8 KB
    const content = makeFile(ext, rng, target);
    writeFileSync(abs, content);
    files.push({ rel, abs, ext, lang: LANG_NAME[ext], size: Buffer.byteLength(content, 'utf8') });
  }

  // 少量 200 KB 大文件当尾部样本
  const bigExts = ['.ts', '.cpp', '.py'];
  for (let j = 0; j < largeCount; j++) {
    const ext = bigExts[j % bigExts.length];
    const rel = `big/large_${j}${ext}`;
    const abs = join(root, rel);
    mkdirSync(join(root, 'big'), { recursive: true });
    const content = makeFile(ext, rng, 200 * 1024);
    writeFileSync(abs, content);
    files.push({ rel, abs, ext, lang: LANG_NAME[ext], size: Buffer.byteLength(content, 'utf8') });
  }

  return { root, files };
}

// ─────────────────────────── 度量工具 ───────────────────────────

function stats(arr) {
  if (arr.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
  };
}
const f3 = (n) => n.toFixed(3);
const f2 = (n) => n.toFixed(2);

// ─────────────────────────── 主流程 ───────────────────────────

let server;
let fixtureRoot;

async function main() {
  // fixture 落在 scratchpad（env）或系统临时目录，不进仓库
  const base = process.env.COMMANDCODE_SCRATCHPAD || tmpdir();
  fixtureRoot = mkdtempSync(join(base, 'openjob-bench-'));
  console.log(`# 仓库索引 / 符号提取性能基准`);
  console.log(`# fixture 根目录: ${fixtureRoot}\n`);

  const QUICK = process.env.BENCH_QUICK === '1'; // 冒烟用，只缩小规模，不改逻辑
  const tiers = [
    { label: '1k', count: QUICK ? 60 : 1000, largeCount: QUICK ? 1 : 3 },
    { label: '10k', count: QUICK ? 120 : 10000, largeCount: QUICK ? 1 : 6 },
  ].map((t) => ({ ...t, fx: buildFixture(join(fixtureRoot, t.label), t) }));

  // tree-sitter 的 grammarDirs() 用 process.cwd()/resources/tree-sitter，切到 desktop 才能命中真实 wasm
  process.chdir(DESKTOP);

  server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    resolve: { alias: [{ find: '@core', replacement: resolve(ROOT, 'core/src') }] },
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  const tsMod = await server.ssrLoadModule('desktop/src/main/repo/treeSitter.ts');
  const filesMod = await server.ssrLoadModule('desktop/src/main/repo/files.ts');
  const ipcMod = await server.ssrLoadModule('desktop/src/renderer/src/ipc/index.ts');

  const results = {};

  // ── 1. tree-sitter 一次性成本：init + 加载全部 grammar（进程全局，测一次）──
  const tiny = (ext) => GEN[ext].decl(0);
  const loadTimes = [];
  let t0 = performance.now();
  await tsMod.extractSymbolsAst(tiny(REP_EXTS[0]), REP_EXTS[0]); // 首次：Parser.init + 第 1 个 grammar
  const initMs = performance.now() - t0;
  const perGrammar = { [REP_EXTS[0]]: initMs };
  for (const ext of REP_EXTS.slice(1)) {
    const t = performance.now();
    await tsMod.extractSymbolsAst(tiny(ext), ext);
    const dt = performance.now() - t;
    perGrammar[ext] = dt;
    loadTimes.push(dt);
  }
  const allGrammarMs = initMs + loadTimes.reduce((a, b) => a + b, 0);
  results.coldStart = { initMs, allGrammarMs, astUsed: tsMod.astWasUsed(), perGrammar };
  console.log('== 1. tree-sitter 一次性成本（进程全局；init=Parser.init + 首个 grammar）==');
  console.log(`   init(ts):        ${f3(initMs)} ms`);
  console.log(`   init + 全 14 grammar: ${f3(allGrammarMs)} ms`);
  console.log(`   ast 成功启用:    ${tsMod.astWasUsed()}\n`);

  // 预热：先跑掉 V8 JIT 与 wasm 的冷路径，否则第一个档位会被冷启动放大数倍
  await warmUp(tsMod, tiers[0].fx);

  // ── 单次调用固定成本（进程内 mock 网关）──
  results.callCost = await measureCallCost(ipcMod, tiers[0].fx);
  console.log('== 7. 单次沙箱调用固定成本（进程内 mock 网关，非真实 Electron IPC）==');
  console.log(`   gateway roundtrip(空 handler): mean ${f3(results.callCost.overhead.mean)} / p50 ${f3(results.callCost.overhead.p50)} / p95 ${f3(results.callCost.overhead.p95)} ms`);
  console.log(`   gateway roundtrip(真实读 ~2KB): mean ${f3(results.callCost.withRead.mean)} / p50 ${f3(results.callCost.withRead.p50)} / p95 ${f3(results.callCost.withRead.p95)} ms\n`);

  for (const tier of tiers) {
    console.log(`────────── 档位 ${tier.label}（${tier.fx.files.length} 文件）──────────`);
    results[tier.label] = await runTier(tier, tsMod, filesMod);
    console.log('');
  }

  // ── 汇总 JSON ──
  console.log('== 汇总 JSON ==');
  console.log(JSON.stringify(results, null, 2));
}

/**
 * 预热 JIT / wasm：结果丢弃，只为让两个档位可比。
 *
 * tree-sitter 的 grammar 是 wasm，V8 对 wasm 函数是惰性分层编译（先 Liftoff 后 TurboFan），
 * 头一两千次 parse 会慢好几倍；不预热的话先跑的档位会被它的冷路径放大 8 倍以上。这里把
 * 1k 档整体跑两遍（≈2000 次 parse）再加几次大文件，足够跨过 tier-up。
 */
async function warmUp(tsMod, fx) {
  const bigs = fx.files.filter((f) => f.size > 16384);
  for (let pass = 0; pass < 2; pass++) {
    for (const f of fx.files) {
      const content = await readFile(f.abs, 'utf8');
      await tsMod.extractSymbolsAst(content, f.ext);
    }
  }
  for (let k = 0; k < 3; k++) {
    for (const f of bigs) {
      const content = await readFile(f.abs, 'utf8');
      await tsMod.extractSymbolsAst(content, f.ext);
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const f of fx.files.slice(0, 400)) {
      const buf = await readFile(f.abs);
      createHash('sha256').update(buf).digest('hex');
    }
  }
}

async function runTier(tier, tsMod, filesMod) {
  const { root, files } = tier.fx;
  const out = {};

  // ── 2. 逐文件 parse + 提符号（内容逐个读取后丢弃，只计 parse 时间）──
  const allMs = [];
  const byLang = new Map();
  const bySize = { '<4KB': [], '4-16KB': [], '>16KB': [] };
  for (const f of files) {
    const content = await readFile(f.abs, 'utf8');
    const t = performance.now();
    await tsMod.extractSymbolsAst(content, f.ext);
    const dt = performance.now() - t;
    allMs.push(dt);
    if (!byLang.has(f.lang)) byLang.set(f.lang, []);
    byLang.get(f.lang).push(dt);
    const bucket = f.size < 4096 ? '<4KB' : f.size <= 16384 ? '4-16KB' : '>16KB';
    bySize[bucket].push(dt);
  }
  const total = stats(allMs);
  out.parse = { total, sumMs: allMs.reduce((a, b) => a + b, 0), byLang: {}, bySize: {} };
  for (const [lang, arr] of [...byLang.entries()].sort()) out.parse.byLang[lang] = stats(arr);
  for (const [b, arr] of Object.entries(bySize)) out.parse.bySize[b] = stats(arr);

  console.log(`== 2. 逐文件 parse + 提符号（extractSymbolsAst，limit 30）==`);
  console.log(`   全体: mean ${f3(total.mean)} / p50 ${f3(total.p50)} / p95 ${f3(total.p95)} ms  (n=${total.n}, 解析总耗时 ${f3(out.parse.sumMs)} ms)`);
  console.log('   按语言:');
  for (const [lang, s] of Object.entries(out.parse.byLang)) {
    console.log(`     ${lang.padEnd(11)} mean ${f3(s.mean)}  p50 ${f3(s.p50)}  p95 ${f3(s.p95)}  (n=${s.n})`);
  }
  console.log('   按大小:');
  for (const [b, s] of Object.entries(out.parse.bySize)) {
    if (s.n) console.log(`     ${b.padEnd(8)} mean ${f3(s.mean)}  p50 ${f3(s.p50)}  p95 ${f3(s.p95)}  (n=${s.n})`);
  }
  console.log('');

  // ── 3. 枚举 + stat ──
  let t = performance.now();
  const listed = await filesMod.listAllFilesAsync(root);
  const walkMs = performance.now() - t;
  t = performance.now();
  let statBytes = 0;
  for (const rel of listed) {
    const st = await stat(join(root, rel));
    statBytes += st.size;
  }
  const statMs = performance.now() - t;
  out.enum = { files: listed.length, walkMs, statMs, totalMs: walkMs + statMs, msPerFile: (walkMs + statMs) / listed.length, statBytes };
  console.log(`== 3. 枚举 + stat ==`);
  console.log(`   listAllFilesAsync(walk): ${f3(walkMs)} ms  (${listed.length} 文件)`);
  console.log(`   stat × ${listed.length}:      ${f3(statMs)} ms`);
  console.log(`   合计: ${f3(out.enum.totalMs)} ms  (${f3(out.enum.msPerFile * 1000)} µs/文件)\n`);

  // ── 4. 读 + sha256 ──
  t = performance.now();
  let bytes = 0;
  for (const f of files) {
    const buf = await readFile(f.abs);
    bytes += buf.length;
    createHash('sha256').update(buf).digest('hex');
  }
  const readHashMs = performance.now() - t;
  const mb = bytes / (1024 * 1024);
  out.readHash = { bytes, mb, ms: readHashMs, mbPerSec: mb / (readHashMs / 1000), msPerFile: readHashMs / files.length };
  console.log(`== 4. 读 + sha256 ==`);
  console.log(`   ${f2(mb)} MB / ${f3(readHashMs)} ms → ${f2(out.readHash.mbPerSec)} MB/s`);
  console.log(`   ${f3(out.readHash.msPerFile)} ms/文件（小文件是每文件系统调用开销主导，不是带宽主导）\n`);

  // ── 5. 整批总墙钟 + 峰值 RSS（一次全量索引）──
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  t = performance.now();
  const fullList = await filesMod.listAllFilesAsync(root);
  const baseline = new Map(); // rel → sha256，供增量档比
  let idxBytes = 0;
  let idxSymbols = 0;
  let n = 0;
  for (const rel of fullList) {
    const abs = join(root, rel);
    const buf = await readFile(abs);
    idxBytes += buf.length;
    baseline.set(rel, createHash('sha256').update(buf).digest('hex'));
    const ext = rel.slice(rel.lastIndexOf('.'));
    if (LANG_NAME[ext]) {
      const hits = await tsMod.extractSymbolsAst(buf.toString('utf8'), ext);
      idxSymbols += hits ? hits.length : 0;
    }
    if (++n % 500 === 0) {
      const m = process.memoryUsage();
      if (m.rss > peakRss) peakRss = m.rss;
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    }
  }
  const fullMs = performance.now() - t;
  const mEnd = process.memoryUsage();
  peakRss = Math.max(peakRss, mEnd.rss);
  peakHeap = Math.max(peakHeap, mEnd.heapUsed);
  out.full = {
    ms: fullMs,
    files: fullList.length,
    mb: idxBytes / (1024 * 1024),
    symbols: idxSymbols,
    peakRssMb: peakRss / (1024 * 1024),
    peakHeapMb: peakHeap / (1024 * 1024),
  };
  console.log(`== 5. 整批全量索引（枚举→读→sha256→提符号）+ 峰值 RSS ==`);
  console.log(`   总墙钟: ${f3(fullMs)} ms  (${fullList.length} 文件, ${f2(out.full.mb)} MB, ${idxSymbols} 个符号)`);
  console.log(`   峰值 RSS: ${f2(out.full.peakRssMb)} MB   峰值 heapUsed: ${f2(out.full.peakHeapMb)} MB\n`);

  // ── 6. 增量：改 10 个文件后重扫（sha 增量的成本）──
  const sample = files.slice(0, 10);
  for (const f of sample) {
    const content = await readFile(f.abs, 'utf8');
    writeFileSync(f.abs, content + '\n' + GEN[f.ext].decl(9999) + '\n');
  }
  t = performance.now();
  let reparsed = 0;
  const incrList = await filesMod.listAllFilesAsync(root);
  for (const rel of incrList) {
    const abs = join(root, rel);
    const buf = await readFile(abs);
    const h = createHash('sha256').update(buf).digest('hex');
    if (baseline.get(rel) === h) continue; // 未变，跳过解析
    const ext = rel.slice(rel.lastIndexOf('.'));
    if (LANG_NAME[ext]) await tsMod.extractSymbolsAst(buf.toString('utf8'), ext);
    reparsed++;
  }
  const incrMs = performance.now() - t;
  out.incr = {
    ms: incrMs,
    changedFiles: sample.length,
    reparsed,
    fullMs,
    ratio: incrMs / fullMs,
  };
  console.log(`== 6. 增量（改 ${sample.length} 个文件后，读+sha 全量、只重解析变化的）==`);
  console.log(`   增量墙钟: ${f3(incrMs)} ms   全量墙钟: ${f3(fullMs)} ms   比值: ${f2(out.incr.ratio)}×\n`);

  return out;
}

async function measureCallCost(ipcMod, fx) {
  const small = fx.files.find((f) => f.size > 1024 && f.size < 4096) ?? fx.files[0];
  const { readFileRangeAsync } = await importReadRange();

  let handler = async () => ({ ok: true });
  globalThis.window = {
    api: {
      invoke: async (channel, payload) => {
        const req = structuredClone(payload);
        const res = await handler(channel, req);
        return structuredClone(res);
      },
    },
  };

  const run = async (n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await ipcMod.invoke('pluginRuntime:workspace.read', { pluginId: 'bench', path: small.rel });
      arr.push(performance.now() - t);
    }
    return stats(arr.slice(10)); // 丢掉前 10 次预热
  };

  const overhead = await run(3000);
  handler = async (channel, req) => readFileRangeAsync(fx.root, req.path);
  const withRead = await run(3000);
  return { overhead, withRead, readPath: small.rel, readBytes: small.size };
}

let _readRangeMod;
async function importReadRange() {
  if (!_readRangeMod) _readRangeMod = await server.ssrLoadModule('desktop/src/main/repo/files.ts');
  return _readRangeMod;
}

try {
  await main();
} catch (err) {
  console.error('基准运行失败:', err);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (fixtureRoot) {
    if (KEEP) console.log(`\n# fixture 保留在: ${fixtureRoot}`);
    else {
      rmSync(fixtureRoot, { recursive: true, force: true });
      console.log(`\n# fixture 已删除: ${fixtureRoot}`);
    }
  }
}
