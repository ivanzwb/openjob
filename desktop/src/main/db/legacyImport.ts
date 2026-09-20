import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRE_PLUGIN_CAMPAIGN_SCOPE_KIND } from '@core/planner/contributions';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

/**
 * 0.6.x → 当前线 的整库升级。
 *
 * 背景：`openjob/openjob.db` 是 0.6.x 留下的库——它的 `__drizzle_migrations` 记的是
 * **那一条线**的迁移集合，与当前线的 journal 不是一套。同一批 tag 的 when 恰好会重合，
 * 但迁移日志、表形状都来自旧线；一旦让 Drizzle 直接在当前线上重放，会在已经存在的
 * 表上撞车（`CREATE TABLE role_profile` 之类），而且失败发生在 `getDb()` 的中途，
 * 容易留下一个「迁移到一半」的文件。
 *
 * 所以这里不去猜、也不原地重放：认出 0.6.x 旧库之后（检测见 `inspectDatabase`），
 * 先把旧库**原样**拷成一份备份（用户的唯一副本），再在一个全新文件上把当前 schema
 * 跑齐，然后按表把旧库的行搬过去，最后落一个持久标记。换库用先建临时文件、再整体
 * 改名的方式完成——任何一步失败都不会动到原始文件，也不会留下半迁移的库。
 *
 * 表形状的差异（本仓库 release/0.6.x 实测）：所有旧表都存活，只有两处列改名
 * （`task.repo_id → material_id`、`company_intel.tech_stack_md → knowledge_tool_map_md`）
 * 和几处新增可空列。改名在 `RENAMED_COLUMNS` 里显式列出——这是已知的、取值不变的
 * 重命名，不是猜测；除此之外列对不上的表一律跳过并汇报，不硬塞。
 *
 * 有一点不属于「搬行」但必须补：0027 的「插件化之前就已存在」标记是在空表上打的，
 * 导入进来的旧战役因此缺这条凭据。导入末尾按 0027 的同一规则补一次，剩下交给
 * 既有的回填（backfillPrePluginCampaignRuntime，见 plugins/bootstrap）。
 *
 * 还有一类库不能只靠「看一眼迁移日志」认出来：跑了一半的半迁移库（早先一次失败的
 * 迁移已经建了 role_profile 之类的表，却没把对应记录写进 __drizzle_migrations）。
 * 它的迁移日志看起来像「我们的线、只是落后」，于是会走正常迁移——然后在已经存在的
 * 表上撞车。所以迁移路径上加了一层兜底（见 getDb）：只要不是最新，迁移前先拷一份
 * 临时快照；迁移撞车就把原库恢复成快照字节，再退回上面这条整库导入。原始数据在任何
 * 情况下都不会被这次尝试改掉。
 */

/** 旧库备份文件名后缀，紧挨着原库放，升级后保留不删。 */
export const LEGACY_BACKUP_SUFFIX = '.legacy-0.6.x.bak';

/**
 * 一次性导入的持久标记（存在 `sync_meta` 里）。
 *
 * 为什么用 sync_meta 而不是 migration_checkpoint：后者按 (campaign_id, kind) 唯一且有
 * 指向 campaign 的外键，而整库导入是全局动作，可能一整个库里一个 campaign 都没有，
 * 放不进去。sync_meta 本来就是「本机单例配置/一次性进度」的落点（`rowVersionBackfilledAt`
 * 就住在这里），与 backfill 那套「写一条 kind 标记、下次启动据此跳过」是同一个套路。
 */
export const LEGACY_IMPORT_MARKER_KEY = 'legacyImport:0.6.x';
/** 标记里写的 kind，与回填的 PRE_PLUGIN_CAMPAIGN_SCOPE_KIND 同构（不同 kind 互不干扰）。 */
export const LEGACY_IMPORT_CHECKPOINT_KIND = 'legacy-0.6.x-import';

/**
 * 已知的列改名（旧列 → 新列），取值不变。
 *
 * 只列真的发生过 RENAME 的：0029 把 task.repo_id 原地改成 material_id，
 * 0030 把 company_intel.tech_stack_md 改成岗位中立的 knowledge_tool_map_md。
 * 新增列（annotation.target_label、campaign.role_profile_id、task.material_kind）
 * 都可空，导入时用默认值，不需要列在这里。
 */
export const RENAMED_COLUMNS: Record<string, Record<string, string>> = {
  task: { repo_id: 'material_id' },
  company_intel: { tech_stack_md: 'knowledge_tool_map_md' },
};

/**
 * 当前线才有的表（插件化那一刻起出现）。旧库里出现其中任何一张就说明它至少跑到过
 * 0023，不能再当 0.6.x 旧库处理——升级路径要保守，认错方向比不认更危险。
 */
const PLUGIN_ERA_TABLES = [
  'role_profile',
  'campaign_plugin_binding',
  'campaign_runtime_descriptor',
  'migration_checkpoint',
  'candidate_evidence',
  'practice_session',
  'story',
  'plugin_data',
] as const;

export type DatabaseKind = 'fresh' | 'current' | 'legacy-0.6.x';

export interface DatabaseInspection {
  kind: DatabaseKind;
  /** 库里出现过的用户表（不含 sqlite_ 内部表）。 */
  tables: string[];
  /** __drizzle_migrations 里记下的 created_at（= 各迁移的 when）。 */
  appliedWhens: number[];
}

export interface LegacyImportTableReport {
  name: string;
  rows: number;
}

export interface LegacyImportSkipReport {
  name: string;
  reason: string;
}

export interface LegacyImportReport {
  backupFile: string;
  tables: LegacyImportTableReport[];
  skipped: LegacyImportSkipReport[];
  /** 一行话的搬迁摘要，供启动日志直接打印。 */
  summary: string;
}

/** 旧库导入失败：带上备份路径，启动失败时用户能据此找回数据。 */
export class LegacyImportError extends Error {
  readonly backupFile: string;

  constructor(message: string, backupFile: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LegacyImportError';
    this.backupFile = backupFile;
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface JournalEntry {
  tag: string;
  when: number;
}

/** 读当前线的迁移 journal。读不出来就返回空数组（视为「没有任何已应用」，最保守）。 */
export function readJournalEntries(migrationsFolder: string): JournalEntry[] {
  try {
    const raw = readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
    return (parsed.entries ?? []).map((entry) => ({ tag: entry.tag, when: entry.when }));
  } catch {
    return [];
  }
}

function userTablesOf(handle: Database.Database, schemaName?: string): string[] {
  const from = schemaName ? `${schemaName}.sqlite_master` : 'sqlite_master';
  return (
    handle
      .prepare(
        `SELECT name FROM ${from}
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function hasMigrationLog(handle: Database.Database): boolean {
  const row = handle
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`,
    )
    .get() as { n: number };
  return row.n > 0;
}

function appliedWhensOf(handle: Database.Database): number[] {
  if (!hasMigrationLog(handle)) return [];
  const rows = handle
    .prepare(`SELECT created_at FROM __drizzle_migrations`)
    .all() as Array<{ created_at: number | string | null }>;
  return rows
    .map((row) => Number(row.created_at))
    .filter((when) => Number.isFinite(when));
}

/**
 * 判定一个已经打开的库属于哪一类（内容判定，不依赖文件名）。
 *
 * - 一个用户表都没有 → fresh：正常建库跑迁移。
 * - 已经整库导入过一次（`sync_meta` 里的一次性标记在位）→ current：标记本身就是「已经是当前线」的凭据。
 * - 迁移日志已经记到当前 journal 的最后一条 → current：本就已经最新，正常迁移（多半空转）。
 * - 有插件化之后的表、且迁移日志的 when 全部落在当前 journal 的 when 集合里 → current：
 *   认得出是我们这条线、只是落后几条，交给正常迁移补齐（迁移前会留一份临时快照兜底）。
 * - 其余 → legacy-0.6.x：走整库导入。包括
 *     · 纯 0.6.x 旧库：用户表在，但没有插件化之后的表；
 *     · 迁移日志的 when 有当前 journal 里根本没有的取值（来自别的线）；
 *     · 有插件化之后的表，但迁移日志对不上（跑了一半、表建了却没记上账的半迁移库）。
 *
 * 关键的一点：「库里出现插件化之后的表」不再等于「它就是当前线」。半迁移库同样有
 * `role_profile`，可它的迁移日志并不能证明这些表是被记过账的——所以还要看迁移日志是不是
 * 我们这条线。反过来也不能只看「when 是当前 journal 的子集」：纯 0.6.x 的 when 恰好与
 * 当前线前 23 条重合、同样落在子集里；真正把这两者分开的是「有没有插件化之后的表」，
 * 而不是迁移日志。两条都满足才算「认得出是我们这条线、只是落后」。
 */
export function inspectDatabase(handle: Database.Database, journalWhens: number[]): DatabaseInspection {
  const tables = userTablesOf(handle);
  const appliedWhens = appliedWhensOf(handle);
  const base = { tables, appliedWhens };

  if (tables.length === 0) return { kind: 'fresh', ...base };

  // 已经导入过一次：标记在位就直接当 current，「跑一次」由它兜底，不依赖下面那条水位推断。
  if (readImportMarker(handle) !== null) return { kind: 'current', ...base };

  // 已经记到当前 journal 的最后一条 → 就是最新。
  const newest = journalWhens.length > 0 ? Math.max(...journalWhens) : 0;
  if (newest > 0 && appliedWhens.includes(newest)) return { kind: 'current', ...base };

  // 迁移日志里的 when 是不是都认得出（落在当前 journal 的 when 集合里）。
  const journalSet = new Set(journalWhens);
  const recordsAreOurs =
    appliedWhens.length > 0 && appliedWhens.every((when) => journalSet.has(when));

  // 有没有插件化之后的表：这是「本仓库当前线」的物理证据，与迁移日志互相印证。
  const pluginEra = PLUGIN_ERA_TABLES.some((table) => tables.includes(table));

  if (pluginEra && recordsAreOurs) return { kind: 'current', ...base };

  return { kind: 'legacy-0.6.x', ...base };
}

/** 迁移日志是否已经包含当前 journal 里最新那条（也就是「没有待跑的迁移」）。 */
export function upToDateWith(appliedWhens: number[], journalWhens: number[]): boolean {
  if (journalWhens.length === 0) return false;
  return appliedWhens.includes(Math.max(...journalWhens));
}

/** 打开文件做一次内容判定；文件缺失/为空视为 fresh，读不动则交给正常路径去报错。 */
export function inspectDatabaseFile(dbFile: string, journalWhens: number[]): DatabaseInspection {
  if (!existsSync(dbFile) || statSync(dbFile).size === 0) {
    return { kind: 'fresh', tables: [], appliedWhens: [] };
  }

  let handle: Database.Database | null = null;
  try {
    handle = new Database(dbFile);
    return inspectDatabase(handle, journalWhens);
  } catch {
    // 打不开（损坏、权限、不是 SQLite）：不当旧库，交给正常路径抛出明确错误
    return { kind: 'current', tables: [], appliedWhens: [] };
  } finally {
    handle?.close();
  }
}

/** 迁移已导入的标记值；没有就返回 null。 */
export function readImportMarker(handle: Database.Database): unknown | null {
  const hasMeta = (
    handle
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='sync_meta'`)
      .get() as { n: number }
  ).n;
  if (hasMeta === 0) return null;
  const row = handle.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(LEGACY_IMPORT_MARKER_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * 迁移前临时快照的后缀，紧挨着原库放。
 *
 * 与 `LEGACY_BACKUP_SUFFIX`（永久保留的 0.6.x 备份）不同：这份快照只服务于「万一迁移跑挂」——
 * 迁移成功即删。它的价值在于把「迁移尝试」变成可回滚的动作：半迁移或异线的库会让 Drizzle
 * 在已经存在的表上撞车，撞了也不怕，恢复回原字节后改走整库导入。
 */
export const PRE_MIGRATE_SNAPSHOT_SUFFIX = '.premigrate.tmp';

/** 迁移前临时快照的路径。 */
export function preMigrateSnapshotPath(dbFile: string): string {
  return `${dbFile}${PRE_MIGRATE_SNAPSHOT_SUFFIX}`;
}

/**
 * 在迁移之前把整库拷成一份临时的、可回滚的现场快照，返回快照路径。
 *
 * 先把 WAL 折回主文件（非 WAL 库上是空转），再整字节拷贝，保证快照自洽、能被原样恢复。
 * 传 handle 是用它来做 checkpoint，避免再开连接（此刻 getDb 正在初始化中途）。
 */
export function snapshotBeforeMigrate(dbFile: string, handle?: Database.Database): string {
  if (handle) {
    handle.pragma('wal_checkpoint(TRUNCATE)');
  } else {
    const temp = new Database(dbFile);
    try {
      temp.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      temp.close();
    }
  }

  const snapshot = preMigrateSnapshotPath(dbFile);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${snapshot}${suffix}`, { force: true });
  copyFileSync(dbFile, snapshot);
  return snapshot;
}

/** 迁移成功后删掉临时快照；没有就什么都不做。 */
export function discardPreMigrateSnapshot(dbFile: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${preMigrateSnapshotPath(dbFile)}${suffix}`, { force: true });
  }
}

/**
 * 迁移失败后，用临时快照把原库恢复成「迁移尝试之前」的字节。
 *
 * 调用前必须先关掉所有指向 dbFile 的连接（Windows 上打开着的文件没法被覆盖）。
 * 迁移过程可能留下 -wal/-shm，它们属于「迁移后」那个状态，覆盖前先清掉，否则 SQLite
 * 会试图把不属于恢复后文件的事务重放进来。恢复完就把快照删掉——之后走整库导入时会另留
 * 一份永久的 `.legacy-0.6.x.bak`。
 */
export function restorePreMigrateSnapshot(dbFile: string): void {
  const snapshot = preMigrateSnapshotPath(dbFile);
  if (!existsSync(snapshot)) {
    throw new Error(`迁移前的临时快照不存在，无法恢复原库：${snapshot}`);
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  copyFileSync(snapshot, dbFile);
  discardPreMigrateSnapshot(dbFile);
}

interface CopyPlanEntry {
  name: string;
  sourceColumns: string[];
  targetColumns: string[];
}

function planTableCopy(
  temp: Database.Database,
  table: string,
): { entry: CopyPlanEntry } | { skip: string } {
  const newColumns = (
    temp.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
  ).map((row) => row.name);
  if (newColumns.length === 0) return { skip: '当前结构里没有这张表' };

  const newColumnSet = new Set(newColumns);
  const rename = RENAMED_COLUMNS[table] ?? {};
  const legacyColumns = (
    temp.prepare(`SELECT name FROM pragma_table_info(?, 'legacy')`).all(table) as Array<{ name: string }>
  ).map((row) => row.name);

  const sourceColumns: string[] = [];
  const targetColumns: string[] = [];
  for (const column of legacyColumns) {
    const target = rename[column] ?? column;
    if (!newColumnSet.has(target)) {
      return { skip: `列 ${column} 在新结构里没有对应（表结构已变）` };
    }
    sourceColumns.push(column);
    targetColumns.push(target);
  }
  if (sourceColumns.length === 0) return { skip: '没有可搬的列' };
  return { entry: { name: table, sourceColumns, targetColumns } };
}

export interface LegacyImportOptions {
  dbFile: string;
  migrationsFolder: string;
  /** 仅供测试注入时间。 */
  now?: () => number;
  /** 仅供测试注入日志。 */
  log?: (message: string) => void;
}

export interface LegacyImportResult {
  raw: Database.Database;
  report: LegacyImportReport;
}

/**
 * 把 0.6.x 旧库整体导入当前结构，返回打开好的新库连接。
 *
 * 顺序刻意如此：备份在前（且是原始字节拷贝），新库建在临时文件上，全部成功后才改名替换。
 * 中途任何一步抛错都会原样冒泡（不再往下走），原始库和备份都还在。
 */
export function importLegacyDatabase(options: LegacyImportOptions): LegacyImportResult {
  const { dbFile, migrationsFolder } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.warn(message));
  const backupFile = `${dbFile}${LEGACY_BACKUP_SUFFIX}`;
  const tempFile = `${dbFile}.legacy-import.tmp`;

  const removeTemp = (): void => {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${tempFile}${suffix}`, { force: true });
    }
  };
  removeTemp();

  try {
    // 1) 备份：先把可能存在的 -wal 折回主文件，再整字节拷贝，保证备份自洽且可原样恢复。
    //    非 WAL 库上 wal_checkpoint 是空转，拷贝与原件逐字节相同。
    const legacy = new Database(dbFile);
    try {
      legacy.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      legacy.close();
    }
    rmSync(backupFile, { force: true });
    copyFileSync(dbFile, backupFile);

    // 2) 在当前线的全新文件上把 schema 跑齐（此刻还没有任何用户数据）。
    const temp = new Database(tempFile);
    let report: LegacyImportReport;
    try {
      temp.pragma('journal_mode = WAL');
      temp.pragma('foreign_keys = ON');
      migrate(drizzle(temp), { migrationsFolder });

      // 把备份挂成第二个库来读；ATTACH 不能在事务里，所以放在建计划之前。
      // 关外键：按表搬行不保证拓扑顺序，外键约束会在中途误伤；搬完再打开。
      temp.pragma('foreign_keys = OFF');
      temp.exec(`ATTACH DATABASE ${quoteLiteral(backupFile)} AS legacy`);
      const plan: CopyPlanEntry[] = [];
      const skipped: LegacyImportSkipReport[] = [];
      const tables: LegacyImportTableReport[] = [];
      try {
        for (const table of userTablesOf(temp, 'legacy').filter((name) => name !== '__drizzle_migrations')) {
          const outcome = planTableCopy(temp, table);
          if ('entry' in outcome) plan.push(outcome.entry);
          else skipped.push({ name: table, reason: outcome.skip });
        }

        const copyAll = temp.transaction(() => {
          for (const entry of plan) {
            const columns = entry.targetColumns.map((column) => `"${column}"`).join(', ');
            const sources = entry.sourceColumns.map((column) => `"${column}"`).join(', ');
            temp
              .prepare(
                `INSERT INTO main."${entry.name}" (${columns}) SELECT ${sources} FROM legacy."${entry.name}"`,
              )
              .run();
          }
        });
        copyAll();
        for (const entry of plan) {
          const row = temp.prepare(`SELECT count(*) AS n FROM main."${entry.name}"`).get() as { n: number };
          tables.push({ name: entry.name, rows: row.n });
        }
      } finally {
        temp.exec('DETACH DATABASE legacy');
      }
      temp.pragma('foreign_keys = ON');

      const completedAt = now();

      // 0027 那条迁移是在空表上跑的——它当时一个 Campaign 都没看到，所以导入进来的旧战役
      // 缺「插件化之前就已存在」的凭据，之后 plugins/bootstrap 的 backfill 会因此选不中它们。
      // 这里按 0027 的同一条规则补一次（role_profile_id 仍为 NULL 的战役即那批），只是把时点
      // 挪到数据到位之后；INSERT OR IGNORE 保证重跑安全。
      temp
        .prepare(
          `INSERT OR IGNORE INTO migration_checkpoint (id, campaign_id, kind, completed_at)
           SELECT ? || ':' || c.id, c.id, ?, ?
           FROM campaign c
           WHERE c.role_profile_id IS NULL`,
        )
        .run(PRE_PLUGIN_CAMPAIGN_SCOPE_KIND, PRE_PLUGIN_CAMPAIGN_SCOPE_KIND, completedAt);

      const marker = {
        kind: LEGACY_IMPORT_CHECKPOINT_KIND,
        completedAt,
        backupFile,
        tables,
        skipped,
      };
      temp
        .prepare(
          `INSERT INTO sync_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(LEGACY_IMPORT_MARKER_KEY, JSON.stringify(marker));

      report = { backupFile, tables, skipped, summary: summarize(tables, skipped, backupFile) };
    } finally {
      temp.close();
    }

    // 3) 换库：先清掉旧库的 -wal/-shm，再把临时文件整体改名覆盖过去。
    //    Node 的 rename 在 Windows 上也是「替换已存在目标」的语义，改名本身是原子的。
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
    renameSync(tempFile, dbFile);
    removeTemp();

    log(`[legacy-import] ${report.summary}`);

    const raw = new Database(dbFile);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    return { raw, report };
  } catch (error) {
    removeTemp();
    const message = error instanceof Error ? error.message : String(error);
    throw new LegacyImportError(
      `这是从 0.6.x 升级上来的旧数据库，需要整库导入到新结构，但导入没完成：${message}。` +
        `原始数据没有被动过，升级前的完整副本在 ${backupFile}，可据此手动恢复。`,
      backupFile,
      { cause: error },
    );
  }
}

function summarize(
  tables: LegacyImportTableReport[],
  skipped: LegacyImportSkipReport[],
  backupFile: string,
): string {
  const rows = tables.reduce((sum, table) => sum + table.rows, 0);
  const skippedText =
    skipped.length === 0
      ? '没有跳过任何表'
      : `跳过 ${skipped.length} 张表（${skipped.map((s) => `${s.name}: ${s.reason}`).join('；')}）`;
  return (
    `已把 0.6.x 旧库导入新结构：导入 ${tables.length} 张表共 ${rows} 行，${skippedText}；` +
    `旧库完整备份保留在 ${backupFile}。`
  );
}
