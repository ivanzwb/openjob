import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 配置所在目录即测试根：用 vitest 默认的 cwd 会因为「从仓库根跑」而找不到用例 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * 端到端测试入口：驱动**真实的 Electron 应用**（隔离 userData + 真窗口 + 真数据库）。
 *
 * 刻意与 `pnpm test` 分开：这一套要起图形进程、跑分钟级的真实链路，不该拖慢每次提交都要
 * 跑的那批单测。跑法见 e2e/README.md。
 *
 * 串行是硬要求，不是保守：每个用例都要占图形端口与同步端口（19721），并发起实例会互相
 * 抢锁。`fileParallelism: false` 让文件之间也排队。
 */
export default defineConfig({
  root: here,
  test: {
    include: ['cases/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
