import { getTableColumns, type Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
// 直接引 schema 而不是 ../db：db/index 要调用本模块装触发器，走桶文件会成环
import * as schema from '../db/schema';

/**
 * 参与端间同步的表清单。
 *
 * 列名不写死，一律从 Drizzle schema 反射，否则以后给业务表加字段时
 * 会忘了同步改触发器，那个字段就会静默地永远同步不过去。
 */

export interface SyncTableSpec {
  /** SQL 表名 */
  name: string;
  /** 主键列的 SQL 名，全部是 text id */
  pk: string;
  /** 所有列的 SQL 名 */
  columns: string[];
  /**
   * 本机专属、永不接受对端值的列。
   * 对端推来的值会被丢弃，本机原值保留。
   */
  deviceLocal: string[];
}

/**
 * 排除项说明（全表清单见 docs/DESIGN.md §6.1）：
 * - search_cache 是纯缓存，两端各自重建即可，同步它只是浪费带宽
 * - prompt_run 是 AB 实验数据，只在产生它的设备上有意义
 * - sync_* 自身不参与同步，否则会递归；水位线表达的本就是两端各自的进度
 */
const SYNCED_TABLES: Array<{ table: Table; deviceLocal?: string[] }> = [
  { table: schema.appSetting },
  { table: schema.resume },
  { table: schema.jobTarget },
  { table: schema.resumeVariant },
  { table: schema.campaign },
  // 作答草稿是本机的：还没提交的半截答案同步过去，两台设备的半成品会用后写
  // 覆盖互相吞字。题目和推荐答案是生成结果，照常同步。
  { table: schema.knowledgeNode, deviceLocal: ['quiz_answer_draft_md'] },
  { table: schema.nodeEdge },
  { table: schema.explanation },
  { table: schema.source },
  { table: schema.companyIntel },
  { table: schema.designCase },
  { table: schema.interviewReport },
  { table: schema.interviewQuestion },
  { table: schema.planDay },
  { table: schema.task },
  { table: schema.quizAttempt },
  // 克隆产物是本机的：路径不能同步。status/indexed_at/summary 等元数据需同步到手机。
  { table: schema.repo, deviceLocal: ['local_path'] },
  { table: schema.codeRef },
  { table: schema.repoFile },
  { table: schema.annotation },
  { table: schema.speechSnippet },
  { table: schema.session },
  { table: schema.message },
  { table: schema.toolCall },
];

function buildSpec(table: Table, deviceLocal: string[]): SyncTableSpec {
  const config = getTableConfig(table);
  const columns = Object.values(getTableColumns(table)).map((c) => c.name);
  const pkColumns = config.columns.filter((c) => c.primary);

  if (pkColumns.length !== 1) {
    throw new Error(`同步表 ${config.name} 必须是单列主键，实际 ${pkColumns.length} 列`);
  }

  const unknown = deviceLocal.filter((c) => !columns.includes(c));
  if (unknown.length > 0) {
    throw new Error(`同步表 ${config.name} 的 deviceLocal 引用了不存在的列：${unknown.join(', ')}`);
  }

  return {
    name: config.name,
    pk: pkColumns[0].name,
    columns,
    deviceLocal,
  };
}

let cached: SyncTableSpec[] | null = null;

export function syncTableSpecs(): SyncTableSpec[] {
  if (!cached) {
    cached = SYNCED_TABLES.map((t) => buildSpec(t.table, t.deviceLocal ?? []));
  }
  return cached;
}

export function syncTableSpec(name: string): SyncTableSpec {
  const spec = syncTableSpecs().find((s) => s.name === name);
  if (!spec) throw new Error(`表 ${name} 不在同步清单里`);
  return spec;
}

/** 对端推来的行里应当被忽略的列 */
export function isDeviceLocalColumn(tableName: string, column: string): boolean {
  return syncTableSpec(tableName).deviceLocal.includes(column);
}
