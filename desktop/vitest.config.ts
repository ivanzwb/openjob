import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 桌面端单元测试配置。
 *
 * 被测对象是 src/main 的纯逻辑模块（IPC 契约、LLM 降档、同步加密、迁移关卡等），
 * 运行在 Node 环境，不启动 Electron。渲染进程不在测试范围内。
 * 路径别名与 tsconfig.node.json / electron.vite.config.ts 保持一致。
 */
export default defineConfig({
  resolve: {
    // 数组形式而不是对象：`@plugins` 要精确匹配，对象形式的键按前缀匹配，
    // `@plugins/softwareEngineering` 会被拼成 `scripts/distributed-role-packs.ts/softwareEngineering`
    alias: [
      { find: '@core', replacement: resolve(import.meta.dirname, '../core/src') },
      { find: '@main', replacement: resolve(import.meta.dirname, 'src/main') },
      { find: '@renderer', replacement: resolve(import.meta.dirname, 'src/renderer/src') },
      { find: /^@plugins$/, replacement: resolve(import.meta.dirname, '../scripts/distributed-role-packs.ts') },
      { find: /^@plugins\//, replacement: `${resolve(import.meta.dirname, '../plugins')}/` },
    ],
  },
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'out', 'src/renderer/**'],
  },
});
