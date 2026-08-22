/**
 * 把当前库和某份快照逐表对一下，看清到底少了什么。
 *
 * 只读，不改任何东西。丢数据这种事靠猜成因很容易改错地方，
 * 这个脚本的作用是把「哪张表少了多少行、少的是哪些行」变成事实。
 *
 *   node scripts/diagnose-data-loss.mjs
 *   node scripts/diagnose-data-loss.mjs <当前库> <快照>
 *
 * 不带参数时自动找 %APPDATA%/OpenJob/openjob.db 和 backups/ 里最新那份快照。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TABLES = [
  'campaign',
  'knowledge_node',
  'node_edge',
  'explanation',
  'session',
  'message',
  'tool_call',
  'quiz_attempt',
  'design_case',
  'company_intel',
  'plan_day',
  'task',
  'annotation',
  'speech_snippet',
  'interview_report',
  'interview_question',
  'resume',
  'resume_variant',
  'job_target',
  'source',
  'repo',
  'repo_file',
  'code_ref',
  'app_setting',
];

function userDataDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  for (const name of ['OpenJob', 'openjob']) {
    const dir = join(appData, name);
    if (existsSync(join(dir, 'openjob.db'))) return dir;
  }
  return null;
}

function newestBackup(dir) {
  const backupsDir = join(dir, 'backups');
  if (!existsSync(backupsDir)) return null;
  const found = readdirSync(backupsDir)
    .map((file) => {
      const m = /^openjob-(\d+)-([a-zA-Z0-9_]+)\.db$/.exec(file);
      return m ? { file, createdAt: Number(m[1]), reason: m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  return found[0] ? join(backupsDir, found[0].file) : null;
}

function resolveArgs() {
  const [current, backup] = process.argv.slice(2);
  if (current && backup) return { current, backup };

  const dir = userDataDir();
  if (!dir) {
    console.error('找不到 OpenJob 的数据目录，请手工传两个路径：');
    console.error('  node scripts/diagnose-data-loss.mjs <当前库> <快照>');
    process.exit(1);
  }
  const resolvedBackup = backup ?? newestBackup(dir);
  if (!resolvedBackup) {
    console.error(`${join(dir, 'backups')} 里没有找到快照`);
    process.exit(1);
  }
  return { current: current ?? join(dir, 'openjob.db'), backup: resolvedBackup };
}

function open(path) {
  if (!existsSync(path)) {
    console.error(`文件不存在：${path}`);
    process.exit(1);
  }
  return new DatabaseSync(path, { readOnly: true });
}

function tableExists(db, table) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
  );
}

function count(db, table) {
  if (!tableExists(db, table)) return null;
  return db.prepare(`SELECT count(*) AS n FROM \`${table}\``).get().n;
}

function pkOf(db, table) {
  const cols = db.prepare(`PRAGMA table_info(\`${table}\`)`).all();
  return cols.find((c) => c.pk === 1)?.name ?? 'id';
}

function missingIds(before, after, table, limit = 5) {
  const pk = pkOf(before, table);
  const oldIds = before.prepare(`SELECT \`${pk}\` AS id FROM \`${table}\``).all().map((r) => r.id);
  if (oldIds.length === 0) return [];
  const stillHere = new Set(
    after.prepare(`SELECT \`${pk}\` AS id FROM \`${table}\``).all().map((r) => r.id),
  );
  return oldIds.filter((id) => !stillHere.has(id)).slice(0, limit);
}

const { current, backup } = resolveArgs();
console.log(`当前库：${current}`);
console.log(`对比快照：${backup}\n`);

const after = open(current);
const before = open(backup);

const rows = [];
for (const table of TABLES) {
  const b = count(before, table);
  const a = count(after, table);
  if (b === null && a === null) continue;
  rows.push({ table, before: b ?? 0, after: a ?? 0, delta: (a ?? 0) - (b ?? 0) });
}

const lost = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta);
const gained = rows.filter((r) => r.delta > 0);

if (lost.length === 0) {
  console.log('没有任何表的行数变少了。');
  console.log('如果界面上确实看不到内容，那问题不在「行被删掉」，而在内容被覆盖或渲染不出来。');
} else {
  console.log('少了行的表（快照 → 当前）：\n');
  for (const r of lost) {
    console.log(`  ${r.table.padEnd(20)} ${String(r.before).padStart(7)} → ${String(r.after).padStart(7)}   ${r.delta}`);
    const ids = missingIds(before, after, r.table);
    if (ids.length) console.log(`    没了的 id 举例：${ids.join(', ')}`);
  }
}

if (gained.length > 0) {
  console.log('\n多了行的表：');
  for (const r of gained) {
    console.log(`  ${r.table.padEnd(20)} ${String(r.before).padStart(7)} → ${String(r.after).padStart(7)}   +${r.delta}`);
  }
}

// 内容被「覆盖成空」和「行被删掉」的处置完全不同，单独查一下。
console.log('\n内容是否被清空（行还在但正文没了）：');
const contentChecks = [
  { table: 'explanation', label: '讲解', columns: ['content_md'] },
  { table: 'message', label: '会话消息', columns: ['content_md'] },
  { table: 'design_case', label: '模拟面试题目', columns: ['scenario_md'] },
  { table: 'design_case', label: '模拟面试作答', columns: ['user_answer_md', 'recommended_answer_md'] },
  { table: 'company_intel', label: '公司情报', columns: ['tech_stack_md', 'interview_process_md'] },
];

for (const check of contentChecks) {
  if (!tableExists(after, check.table) || !tableExists(before, check.table)) {
    console.log(`  ${check.label.padEnd(14)} 跳过：表不存在`);
    continue;
  }
  const cols = before.prepare(`PRAGMA table_info(\`${check.table}\`)`).all().map((c) => c.name);
  const usable = check.columns.filter((c) => cols.includes(c));
  if (usable.length === 0) {
    // 静默跳过会让人误以为「查过了，没问题」，必须说出来
    console.log(`  ${check.label.padEnd(14)} 跳过：列不存在（${check.columns.join(', ')}）`);
    continue;
  }

  const nonEmpty = (db) => {
    const cond = usable.map((c) => `coalesce(\`${c}\`, '') <> ''`).join(' OR ');
    return db.prepare(`SELECT count(*) AS n FROM \`${check.table}\` WHERE ${cond}`).get().n;
  };
  const b = nonEmpty(before);
  const a = nonEmpty(after);
  const flag = a < b ? '  ← 变少了' : '';
  console.log(`  ${check.label.padEnd(14)} 有内容的行 ${String(b).padStart(6)} → ${String(a).padStart(6)}${flag}`);
}

// 以下都只看当前库，用来判断「谁把数据动掉了」
console.log('\n最近的同步记录：');
if (tableExists(after, 'sync_run')) {
  const runs = after
    .prepare(
      `SELECT started_at, status, applied_count, overwrite_count, error_message
       FROM sync_run ORDER BY started_at DESC LIMIT 15`,
    )
    .all();
  for (const r of runs) {
    console.log(
      `  ${new Date(r.started_at).toLocaleString()} ${String(r.status).padEnd(9)}` +
        ` 应用 ${String(r.applied_count).padStart(4)} 覆盖 ${String(r.overwrite_count).padStart(3)}` +
        ` ${r.error_message ?? ''}`,
    );
  }
} else {
  console.log('  没有 sync_run 表');
}

console.log('\n本机 oplog 里的删除记录（按表）：');
if (tableExists(after, 'sync_oplog')) {
  const dels = after
    .prepare(
      `SELECT table_name, count(*) AS n, min(wall_ms) AS first, max(wall_ms) AS last
       FROM sync_oplog WHERE op = 'delete' GROUP BY table_name ORDER BY n DESC`,
    )
    .all();
  if (dels.length === 0) console.log('  没有本机发起的删除');
  for (const r of dels) {
    console.log(
      `  ${r.table_name.padEnd(18)} ${String(r.n).padStart(5)}` +
        `  ${new Date(r.first).toLocaleString()} → ${new Date(r.last).toLocaleString()}`,
    );
  }
  console.log('  注意：应用对端变更时不写 oplog，所以这里只有本机发起的删除。');
} else {
  console.log('  没有 sync_oplog 表');
}

// updated_ms 太小的行在后写覆盖里永远输，会被对端整体压掉
console.log('\n行版本时间可疑的行（updated_ms 小于 2001 年，会在后写覆盖里必输）：');
if (tableExists(after, 'sync_row_version')) {
  const bad = after
    .prepare(
      `SELECT table_name, count(*) AS n FROM sync_row_version
       WHERE updated_ms < 1000000000000 GROUP BY table_name ORDER BY n DESC`,
    )
    .all();
  if (bad.length === 0) console.log('  没有');
  for (const r of bad) console.log(`  ${r.table_name.padEnd(18)} ${String(r.n).padStart(5)}`);
} else {
  console.log('  没有 sync_row_version 表');
}

after.close();
before.close();
