/**
 * 包数据集合（阶段 3 B2）的宿主实现行为。
 *
 * 用例钉三件事：
 * 1. **隔离**：一个包看不到另一个包的行——集合名与键相同也一样，因为读写都按 plugin_id 收窄；
 * 2. **声明即授权**：没装、或没在自己 manifest 声明过这个集合，一律拒；
 * 3. **形状上限**：键长、值长、limit 与非法字符都拦在写库/查询之前。
 *
 * 值一律按字符串原样存取，宿主从不解析——所以这里也从不假设值是 JSON。
 */
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@core/plugins/types';
import * as schema from '../db/schema';
import { applyMigrations } from '../db/__fixtures__/migratedDb';
import type { PluginInventoryEntry } from './inventory';
import { setExternalPlugins } from './runtime';

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../db', async () => {
  const real = await import('../db/schema');
  return { getDb: () => dbRef.current, schema: real };
});

const {
  pluginDataCount,
  pluginDataDelete,
  pluginDataGet,
  pluginDataList,
  pluginDataSet,
  assertDataCollectionDeclared,
} = await import('./pluginData');

/**
 * 在 node:sqlite 上搭一个够 drizzle 用的 better-sqlite3 垫片。
 *
 * 迁移文件是真文件（与生产同一批 DDL）；`raw()` 切到数组行，drizzle 的 fields 映射认这个形状。
 */
function newDrizzleDb(): ReturnType<typeof drizzle<typeof schema>> {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys = ON');
  applyMigrations({ exec: (sql: string) => native.exec(sql) } as unknown as Database, {});

  const client = {
    prepare(sql: string) {
      const stmt = native.prepare(sql);
      return {
        run: (...args: unknown[]) => stmt.run(...(args as never[])),
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[])),
        raw() {
          stmt.setReturnArrays(true);
          return {
            get: (...args: unknown[]) => stmt.get(...(args as never[])),
            all: (...args: unknown[]) => stmt.all(...(args as never[])),
          };
        },
      };
    },
    exec: (sql: string) => native.exec(sql),
  };
  return drizzle(client as unknown as Database, { schema });
}

const ALPHA = 'demo.alpha';
const BETA = 'demo.beta';
const COLLECTION = 'notes';

function dataManifest(id: string, collections: readonly string[]): PluginManifest {
  return {
    id,
    version: '1.0.0',
    type: 'plugin',
    displayName: id,
    description: id,
    compatibility: { core: '^1.0.0', schema: 28 },
    permissions: [],
    main: 'desktop/main.js',
    api: '^1.0',
    dataCollections: collections.map((name) => ({ name, schemaVersion: 1 })),
  };
}

function entry(manifest: PluginManifest): PluginInventoryEntry {
  return {
    dir: `/test/plugins/${manifest.id}@${manifest.version}`,
    trust: 'first-party',
    package: { manifest },
  };
}

/** 装上若干包，每个都声明同一个集合名。 */
function install(ids: readonly string[], collection = COLLECTION): void {
  setExternalPlugins(ids.map((id) => entry(dataManifest(id, [collection]))));
}

beforeEach(() => {
  dbRef.current = newDrizzleDb();
  setExternalPlugins([]);
});

afterEach(() => {
  setExternalPlugins([]);
  vi.restoreAllMocks();
});

describe('隔离：一个包看不到另一个包的行', () => {
  it('两个包用同一个集合名与键也互不可见', () => {
    setExternalPlugins([
      entry(dataManifest(ALPHA, [COLLECTION])),
      entry(dataManifest(BETA, [COLLECTION])),
    ]);

    pluginDataSet(ALPHA, COLLECTION, 'k1', 'alpha-value');
    pluginDataSet(BETA, COLLECTION, 'k1', 'beta-value');

    expect(pluginDataGet(ALPHA, COLLECTION, 'k1')).toBe('alpha-value');
    expect(pluginDataGet(BETA, COLLECTION, 'k1')).toBe('beta-value');
    expect(pluginDataCount(ALPHA, COLLECTION)).toBe(1);
    expect(pluginDataCount(BETA, COLLECTION)).toBe(1);

    // 删自己那份不影响对端同名的行
    pluginDataDelete(ALPHA, COLLECTION, 'k1');
    expect(pluginDataGet(ALPHA, COLLECTION, 'k1')).toBeNull();
    expect(pluginDataGet(BETA, COLLECTION, 'k1')).toBe('beta-value');
  });
});

describe('声明即授权', () => {
  it('包装着但没声明这个集合 → 拒', () => {
    install([ALPHA]);

    expect(() => pluginDataGet(ALPHA, 'other', 'k')).toThrow('未声明的数据集合：other');
    expect(() => pluginDataSet(ALPHA, 'other', 'k', 'v')).toThrow('未声明的数据集合：other');
    expect(() => pluginDataList(ALPHA, 'other')).toThrow('未声明的数据集合：other');
    expect(() => pluginDataCount(ALPHA, 'other')).toThrow('未声明的数据集合：other');
    expect(() => pluginDataDelete(ALPHA, 'other', 'k')).toThrow('未声明的数据集合：other');
  });

  it('包没装 → 拒（与没声明同一个答复）', () => {
    setExternalPlugins([]);

    expect(() => assertDataCollectionDeclared(ALPHA, COLLECTION)).toThrow(
      '未声明的数据集合：notes',
    );
    expect(() => pluginDataGet(ALPHA, COLLECTION, 'k')).toThrow('未声明的数据集合：notes');
  });

  it('插件 id 不合法直接拒，不落到授权判断', () => {
    install([ALPHA]);

    expect(() => pluginDataGet('../evil', COLLECTION, 'k')).toThrow('插件 id 不合法');
  });
});

describe('形状上限', () => {
  it('空的键、超长键、超长值都被拦在写库之前', () => {
    install([ALPHA]);

    expect(() => pluginDataSet(ALPHA, COLLECTION, '', 'v')).toThrow('数据键不能为空');
    expect(() => pluginDataSet(ALPHA, COLLECTION, 'a'.repeat(513), 'v')).toThrow('数据键超过 512');
    expect(() => pluginDataSet(ALPHA, COLLECTION, 'k', 'v'.repeat(256 * 1024 + 1))).toThrow(
      '数据值超过',
    );

    // 正好到上限的键与值应当写入成功
    pluginDataSet(ALPHA, COLLECTION, 'a'.repeat(512), 'v'.repeat(256 * 1024));
    expect(pluginDataGet(ALPHA, COLLECTION, 'a'.repeat(512))).toHaveLength(256 * 1024);
  });

  it('limit 必须在 1–1000 内，缺省 200', () => {
    install([ALPHA]);

    expect(() => pluginDataList(ALPHA, COLLECTION, { limit: 0 })).toThrow('limit 必须在 1–1000');
    expect(() => pluginDataList(ALPHA, COLLECTION, { limit: 1001 })).toThrow('limit 必须在 1–1000');
    expect(() => pluginDataList(ALPHA, COLLECTION, { limit: 2.5 })).toThrow('limit 必须在 1–1000');

    for (let i = 0; i < 205; i += 1) {
      pluginDataSet(ALPHA, COLLECTION, `k${String(i).padStart(3, '0')}`, 'v');
    }
    // 缺省上限 200：多出来的行不会一次全给
    expect(pluginDataList(ALPHA, COLLECTION)).toHaveLength(200);
    expect(pluginDataList(ALPHA, COLLECTION, { limit: 1000 })).toHaveLength(205);
  });

  it('集合名与键不得含 U+001F 或其它控制字符', () => {
    install([ALPHA]);

    expect(() => pluginDataGet(ALPHA, 'bad\u001fname', 'k')).toThrow('控制字符');
    expect(() => pluginDataSet(ALPHA, COLLECTION, 'bad\nkey', 'v')).toThrow('控制字符');
    expect(() => pluginDataList(ALPHA, COLLECTION, { prefix: 'bad\u0000prefix' })).toThrow(
      '控制字符',
    );
  });
});

describe('取值', () => {
  it('list 按前缀过滤、按键升序，结果受 limit 截断', () => {
    install([ALPHA]);
    pluginDataSet(ALPHA, COLLECTION, 'docs/a', '1');
    pluginDataSet(ALPHA, COLLECTION, 'docs/b', '2');
    pluginDataSet(ALPHA, COLLECTION, 'docs/c', '3');
    pluginDataSet(ALPHA, COLLECTION, 'other', '4');

    expect(pluginDataList(ALPHA, COLLECTION).map((row) => row.key)).toEqual([
      'docs/a',
      'docs/b',
      'docs/c',
      'other',
    ]);
    expect(pluginDataList(ALPHA, COLLECTION, { prefix: 'docs/' }).map((row) => row.key)).toEqual([
      'docs/a',
      'docs/b',
      'docs/c',
    ]);
    expect(
      pluginDataList(ALPHA, COLLECTION, { prefix: 'docs/', limit: 2 }).map((row) => row.key),
    ).toEqual(['docs/a', 'docs/b']);
    expect(pluginDataList(ALPHA, COLLECTION, { prefix: 'docs/' })[0]!.value).toBe('1');
  });

  it('前缀里的 % 与 _ 按字面量处理，不当通配符', () => {
    install([ALPHA]);
    pluginDataSet(ALPHA, COLLECTION, 'a%b', '1');
    pluginDataSet(ALPHA, COLLECTION, 'axb', '2');
    pluginDataSet(ALPHA, COLLECTION, 'a_b', '3');
    pluginDataSet(ALPHA, COLLECTION, 'aXb', '4');

    expect(pluginDataList(ALPHA, COLLECTION, { prefix: 'a%' }).map((row) => row.key)).toEqual([
      'a%b',
    ]);
    expect(pluginDataList(ALPHA, COLLECTION, { prefix: 'a_' }).map((row) => row.key)).toEqual([
      'a_b',
    ]);
  });

  it('同键写入是覆盖，值原样存取（宿主不解析）', () => {
    install([ALPHA]);

    pluginDataSet(ALPHA, COLLECTION, 'k', '{"v":1}');
    expect(pluginDataGet(ALPHA, COLLECTION, 'k')).toBe('{"v":1}');

    pluginDataSet(ALPHA, COLLECTION, 'k', 'plain text');
    expect(pluginDataGet(ALPHA, COLLECTION, 'k')).toBe('plain text');
    expect(pluginDataCount(ALPHA, COLLECTION)).toBe(1);
  });

  it('delete 幂等：删不存在的键不报错，也不动别的行', () => {
    install([ALPHA]);
    pluginDataSet(ALPHA, COLLECTION, 'k1', 'v1');
    pluginDataSet(ALPHA, COLLECTION, 'k2', 'v2');

    expect(() => pluginDataDelete(ALPHA, COLLECTION, 'missing')).not.toThrow();
    pluginDataDelete(ALPHA, COLLECTION, 'k1');
    expect(() => pluginDataDelete(ALPHA, COLLECTION, 'k1')).not.toThrow();

    expect(pluginDataGet(ALPHA, COLLECTION, 'k1')).toBeNull();
    expect(pluginDataGet(ALPHA, COLLECTION, 'k2')).toBe('v2');
  });

  it('count 只数本包本集合的行', () => {
    setExternalPlugins([
      entry(dataManifest(ALPHA, [COLLECTION, 'other'])),
      entry(dataManifest(BETA, [COLLECTION])),
    ]);
    pluginDataSet(ALPHA, COLLECTION, 'a', '1');
    pluginDataSet(ALPHA, COLLECTION, 'b', '2');
    pluginDataSet(ALPHA, 'other', 'x', '3');
    pluginDataSet(BETA, COLLECTION, 'a', '9');

    expect(pluginDataCount(ALPHA, COLLECTION)).toBe(2);
    expect(pluginDataCount(ALPHA, 'other')).toBe(1);
    expect(pluginDataCount(BETA, COLLECTION)).toBe(1);
  });
});
