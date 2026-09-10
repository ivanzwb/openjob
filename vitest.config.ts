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
    // 数组形式而不是对象：`@plugins` 要精确匹配，对象形式的键按前缀匹配，
    // `@plugins/softwareEngineering` 会被拼成 `plugins/index.ts/softwareEngineering`
    alias: [
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
      { find: '@main', replacement: resolve(__dirname, 'src/main') },
      { find: /^@plugins$/, replacement: resolve(__dirname, 'plugins/index.ts') },
      { find: /^@plugins\//, replacement: `${resolve(__dirname, 'plugins')}/` },
    ],
  },
  test: {
    environment: 'node',
    // plugins/ 下的岗位包自带契约与黄金用例，它们跟着包一起走，不在 src 里
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts'],
    // 迁移自 scripts/smoke-sync-merge.ts 的合并引擎用例在这里
    exclude: ['node_modules', 'dist', 'out', 'src/renderer/**'],
  },
});
