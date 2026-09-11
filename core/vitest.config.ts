import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * core 的单元测试：合并引擎、IPC 契约、Prompt 装配、插件契约等纯逻辑，跑在 Node 里。
 *
 * `@plugins` 只有测试会用（岗位包是单独分发的数据，core 的运行时代码一行都不许引用，
 * 见 desktop/src/main/plugins/basePackage.test.ts）。数组形式的别名是因为 `@plugins` 要精确匹配——
 * 对象形式的键按前缀匹配，`@plugins/softwareEngineering` 会被拼成 scripts/distributed-role-packs.ts/softwareEngineering。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@core', replacement: resolve(import.meta.dirname, 'src') },
      { find: /^@plugins$/, replacement: resolve(import.meta.dirname, '../scripts/distributed-role-packs.ts') },
      { find: /^@plugins\//, replacement: `${resolve(import.meta.dirname, '../plugins')}/` },
    ],
  },
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
