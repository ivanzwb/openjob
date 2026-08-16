import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Prompt AB 离线回归：直读桌面端 openjob.db 的 prompt_run 表，
 * 对比同一 prompt 的两个版本（v1 vs v2），给出字段完整性 / token / 延迟 / 成功率差异。
 *
 * 用 Node 内置 node:sqlite 直读——better-sqlite3 被 rebuild 成 Electron ABI，
 * 纯 Node 加载不了。只读，绝不写库。
 *
 * 用法：
 *   node scripts/prompt-ab-regression.mjs <promptId> [dbPath]
 *   node scripts/prompt-ab-regression.mjs quiz.question
 *   node scripts/prompt-ab-regression.mjs quiz.question "C:\Users\me\AppData\Roaming\openjob\openjob.db"
 */

const promptId = process.argv[2];
if (!promptId) {
  console.error('用法: node scripts/prompt-ab-regression.mjs <promptId> [dbPath]');
  process.exit(1);
}

function defaultDbPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    return appData
      ? resolve(appData, 'openjob', 'openjob.db')
      : resolve(homedir(), 'AppData', 'Roaming', 'openjob', 'openjob.db');
  }
  if (platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'openjob', 'openjob.db');
  }
  return resolve(homedir(), '.config', 'openjob', 'openjob.db');
}

const dbPath = process.argv[3] ?? defaultDbPath();
if (!existsSync(dbPath)) {
  console.error(`数据库不存在: ${dbPath}`);
  console.error('可传入显式路径，或先运行桌面端产生 prompt_run 数据。');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

/** 表是否存在（老库还没跑 0013 迁移时 prompt_run 不存在，给个友好提示） */
function hasPromptRunTable() {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompt_run'`)
    .get();
  return row !== undefined;
}

if (!hasPromptRunTable()) {
  console.error('prompt_run 表不存在——该库还没有 prompt AB 数据，或尚未应用 0013 迁移。');
  process.exit(1);
}

const versionRows = db
  .prepare(`SELECT DISTINCT version_id FROM prompt_run WHERE prompt_id = ?`)
  .all(promptId);
const versions = versionRows.map((r) => r.version_id);

if (versions.length === 0) {
  console.error(`promptId "${promptId}" 没有任何调用记录。`);
  process.exit(1);
}

const entries = db
  .prepare(
    `SELECT version_id, ok, error, latency_ms, prompt_tokens, completion_tokens, output_json, created_at
     FROM prompt_run WHERE prompt_id = ? ORDER BY created_at ASC`,
  )
  .all(promptId);

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function fmtTime(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function aggregate(list) {
  const latencies = list.map((e) => e.latency_ms).sort((a, b) => a - b);
  const okRuns = list.filter((e) => e.ok === 1).length;
  return {
    runs: list.length,
    okRuns,
    okRate: okRuns / Math.max(1, list.length),
    avgLatency: Math.round(list.reduce((s, e) => s + e.latency_ms, 0) / Math.max(1, list.length)),
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
    avgPromptTokens: Math.round(
      list.reduce((s, e) => s + (e.prompt_tokens ?? 0), 0) / Math.max(1, list.length),
    ),
    avgCompletionTokens: Math.round(
      list.reduce((s, e) => s + (e.completion_tokens ?? 0), 0) / Math.max(1, list.length),
    ),
  };
}

/** 字段完整性：各版本成功输出顶层字段集合 */
function fieldSets(list) {
  const map = new Map();
  for (const e of list) {
    if (e.ok !== 1 || !e.output_json) continue;
    try {
      const parsed = JSON.parse(e.output_json);
      const keys = map.get(e.version_id) ?? new Set();
      for (const key of Object.keys(parsed)) keys.add(key);
      map.set(e.version_id, keys);
    } catch {
      // 输出不可解析，跳过——该行本身会在成功率里体现
    }
  }
  return map;
}

console.log(`\n=== Prompt AB 回归: ${promptId} ===`);
console.log(`库: ${dbPath}`);
console.log(`版本: ${versions.join(', ')}  总调用: ${entries.length}\n`);

for (const versionId of versions) {
  const list = entries.filter((e) => e.version_id === versionId);
  const agg = aggregate(list);
  const errors = list.filter((e) => e.ok !== 1).slice(0, 3);
  console.log(`--- ${versionId} (${agg.runs} 次) ---`);
  console.log(
    `  成功率: ${(agg.okRate * 100).toFixed(1)}%  (${agg.okRuns}/${agg.runs})` +
      `  延迟: avg ${fmtTime(agg.avgLatency)} / p50 ${fmtTime(agg.p50)} / p95 ${fmtTime(agg.p95)}`,
  );
  console.log(
    `  token: prompt avg ${agg.avgPromptTokens} / completion avg ${agg.avgCompletionTokens}`,
  );
  if (errors.length > 0) {
    console.log(`  失败样例:`);
    for (const err of errors) {
      console.log(`    - ${err.error ?? '未知错误'}`);
    }
  }
  console.log('');
}

if (versions.length >= 2) {
  console.log(`=== 双版对比 ===`);
  const fields = fieldSets(entries);
  const [a, b] = versions;
  const aggA = aggregate(entries.filter((e) => e.version_id === a));
  const aggB = aggregate(entries.filter((e) => e.version_id === b));

  const keysA = fields.get(a) ?? new Set();
  const keysB = fields.get(b) ?? new Set();
  const onlyInA = [...keysA].filter((k) => !keysB.has(k));
  const onlyInB = [...keysB].filter((k) => !keysA.has(k));

  console.log(`字段完整性: ${a} 有 ${keysA.size} 个顶层字段, ${b} 有 ${keysB.size} 个`);
  if (onlyInA.length > 0) console.log(`  仅 ${a} 有: ${onlyInA.join(', ')}`);
  if (onlyInB.length > 0) console.log(`  仅 ${b} 有: ${onlyInB.join(', ')}`);
  if (onlyInA.length === 0 && onlyInB.length === 0) console.log(`  顶层字段集合一致 ✓`);

  console.log(`\n成功率: ${a} ${(aggA.okRate * 100).toFixed(1)}% vs ${b} ${(aggB.okRate * 100).toFixed(1)}%`);
  console.log(`延迟 avg: ${a} ${fmtTime(aggA.avgLatency)} vs ${b} ${fmtTime(aggB.avgLatency)}`);
  console.log(
    `completion token avg: ${a} ${aggA.avgCompletionTokens} vs ${b} ${aggB.avgCompletionTokens}`,
  );

  const verdict = [];
  if (aggB.okRate < aggA.okRate - 0.05) verdict.push('⚠ 新版成功率显著下降');
  if (aggB.avgLatency > aggA.avgLatency * 1.5) verdict.push('⚠ 新版延迟明显变高');
  if (onlyInB.length > 0) verdict.push('ℹ 新版出现新字段');
  if (onlyInA.length > 0) verdict.push('⚠ 新版丢失字段，注意回归');
  if (verdict.length === 0) verdict.push('✓ 双版指标相当，无明显回归');
  console.log(`\n结论: ${verdict.join('；')}\n`);
} else {
  console.log(`只有一个版本的数据——开启实验（experiments.json）后新版流量会打上 v2。`);
  console.log(`对照脚本: node scripts/prompt-ab-regression.mjs ${promptId}`);
}

db.close();