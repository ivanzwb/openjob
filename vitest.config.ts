import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 桌面端单元测试配置。
 *
 * 被测对象是 src/shared 与 src/main 的纯逻辑模块（合并引擎、IPC 契约、
 * LLM 降档、同步加密等），运行在 Node 环境，不启动 Electron。
 * 路径别名与 tsconfig.node.json / electron.vite.config 保持一致。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 迁移自 scripts/smoke-sync-merge.ts 的合并引擎用例在这里
    exclude: ['node_modules', 'dist', 'out', 'src/renderer/**'],
  },
});
