/**
 * 包自声明的数据集合的通用承载层（阶段 3 B2）。
 *
 * 宿主不理解值的语义：值一律是字符串，原样写进 value_json，由包自己序列化与反序列化
 * （与 ctx.storage 同一份契约）。行按 (plugin_id, collection, key) 归档，主键由宿主用
 * U+001F 拼出；跨端同步走与业务表同一条 oplog + 后写覆盖，所以 id 必须能由三段自证。
 *
 * 授权来自声明：调用方只有在自己 manifest 声明过这个集合时才能读写——宿主不认识任何
 * 具体集合名，只按声明放行（见 assertDataCollectionDeclared）。每次读写都按 plugin_id
 * 收窄，一个包看不到另一个包的行。
 */
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { isStablePluginId } from '@core/plugins/contracts';
import { getDb, schema } from '../db';
import { listExternalPlugins, listInstalledPlugins } from './runtime';

/** 主键分隔符：U+001F。任何输入里出现它，或任何控制字符，都直接拒。 */
const ID_SEPARATOR = '\u001f';

const MAX_KEY_LENGTH = 512;
const MAX_VALUE_LENGTH = 256 * 1024;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export interface PluginDataListOptions {
  /** 只取以它开头的键；缺省表示不按前缀过滤 */
  prefix?: string;
  /** 返回条数上限，1–1000，缺省 200；结果被上限截断，调用方按前缀翻页 */
  limit?: number;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 集合名 / 键 / 前缀共用的形状规则：非空、不含 U+001F 与控制字符。 */
function assertSafeToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}不能为空`);
  }
  if (hasControlCharacter(value)) {
    throw new Error(`${label}不能包含控制字符`);
  }
  return value;
}

function assertKey(key: unknown): string {
  const normalized = assertSafeToken(key, '数据键');
  if (normalized.length > MAX_KEY_LENGTH) {
    throw new Error(`数据键超过 ${MAX_KEY_LENGTH} 字符上限`);
  }
  return normalized;
}

/**
 * 声明即授权：调用方自己的 manifest 必须声明过这个集合。
 *
 * 事实源是本机安装清单——没装这个包、或包没声明这个集合，一律拒；两种情况的答复相同
 * （对调用方来说这个名字都不可用）。这是唯一的授权入口，所有读写都先过它。
 */
export function assertDataCollectionDeclared(pluginId: string, collection: string): void {
  if (!isStablePluginId(pluginId)) throw new Error(`插件 id 不合法：${String(pluginId)}`);
  assertSafeToken(collection, '集合名');

  const installed = listInstalledPlugins().some((plugin) => plugin.id === pluginId);
  const entry = installed
    ? listExternalPlugins().find((item) => item.package.manifest.id === pluginId)
    : undefined;
  const declared = entry?.package.manifest.dataCollections?.some(
    (item) => item.name === collection,
  );
  if (declared !== true) throw new Error(`未声明的数据集合：${collection}`);
}

/** 主键由宿主拼出：id = pluginId \u001f collection \u001f key。 */
function dataRowId(pluginId: string, collection: string, key: string): string {
  return `${pluginId}${ID_SEPARATOR}${collection}${ID_SEPARATOR}${key}`;
}

function scopeColumns(pluginId: string, collection: string) {
  return and(
    eq(schema.pluginData.pluginId, pluginId),
    eq(schema.pluginData.collection, collection),
  );
}

export function pluginDataGet(pluginId: string, collection: string, key: string): string | null {
  assertDataCollectionDeclared(pluginId, collection);
  const normalizedKey = assertKey(key);
  const row = getDb()
    .select({ value: schema.pluginData.valueJson })
    .from(schema.pluginData)
    .where(and(scopeColumns(pluginId, collection), eq(schema.pluginData.key, normalizedKey)))
    .get();
  return row?.value ?? null;
}

export function pluginDataList(
  pluginId: string,
  collection: string,
  options: PluginDataListOptions = {},
): Array<{ key: string; value: string }> {
  assertDataCollectionDeclared(pluginId, collection);

  const limit = options.limit === undefined ? DEFAULT_LIST_LIMIT : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`limit 必须在 1–${MAX_LIST_LIMIT} 内`);
  }
  const conditions = [scopeColumns(pluginId, collection)];
  if (options.prefix !== undefined) {
    const prefix = assertSafeToken(options.prefix, '前缀');
    // 前缀用 substr 逐字比对：LIKE 会把 % 与 _ 当通配符，键里出现它们就会多取。
    conditions.push(sql`substr(${schema.pluginData.key}, 1, length(${prefix})) = ${prefix}`);
  }

  const rows = getDb()
    .select({ key: schema.pluginData.key, value: schema.pluginData.valueJson })
    .from(schema.pluginData)
    .where(and(...conditions))
    .orderBy(asc(schema.pluginData.key))
    .limit(limit)
    .all();
  return rows.map((row) => ({ key: row.key, value: row.value ?? '' }));
}

export function pluginDataCount(pluginId: string, collection: string): number {
  assertDataCollectionDeclared(pluginId, collection);
  const row = getDb()
    .select({ value: count() })
    .from(schema.pluginData)
    .where(scopeColumns(pluginId, collection))
    .get();
  return row?.value ?? 0;
}

export function pluginDataSet(
  pluginId: string,
  collection: string,
  key: string,
  value: string,
): void {
  assertDataCollectionDeclared(pluginId, collection);
  const normalizedKey = assertKey(key);
  if (typeof value !== 'string') throw new Error('数据值必须是字符串');
  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error(`数据值超过 ${MAX_VALUE_LENGTH} 字符上限`);
  }

  const updatedAt = Date.now();
  getDb()
    .insert(schema.pluginData)
    .values({
      id: dataRowId(pluginId, collection, normalizedKey),
      pluginId,
      collection,
      key: normalizedKey,
      valueJson: value,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.pluginData.id,
      set: { valueJson: value, updatedAt },
    })
    .run();
}

export function pluginDataDelete(pluginId: string, collection: string, key: string): void {
  assertDataCollectionDeclared(pluginId, collection);
  const normalizedKey = assertKey(key);
  getDb()
    .delete(schema.pluginData)
    .where(and(scopeColumns(pluginId, collection), eq(schema.pluginData.key, normalizedKey)))
    .run();
}
