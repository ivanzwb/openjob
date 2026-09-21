/**
 * 直接读副本里的 SQLite 做断言。
 *
 * 界面对了不等于库对了：写一半、状态没推进、外键没解开这类问题只有看盘才发现得了。
 * 用 node:sqlite（Node 自带），不引第三方依赖。
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sleep } from './app';

export class AppDb {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): AppDb {
    if (!existsSync(file)) throw new Error(`库不存在：${file}`);
    // 应用用 WAL，读连接必须能碰 -shm；readOnly 在部分平台会直接 SQLITE_READONLY，这里只读不放
    return new AppDb(new DatabaseSync(file));
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  count(table: string, where = '1', ...params: unknown[]): number {
    const row = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params);
    return Number(row?.n ?? 0);
  }

  /** 等一行出现：AI 路径是异步落库的，断言前给它一点时间 */
  async waitForRow<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    label = sql,
    timeout = 60_000,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const row = this.get<T>(sql, ...params);
      if (row) return row;
      if (Date.now() > deadline) throw new Error(`等待落库超时：${label}`);
      await sleep(300);
    }
  }

  close(): void {
    this.db.close();
  }
}
