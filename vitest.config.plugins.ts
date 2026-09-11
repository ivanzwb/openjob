import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 岗位包自带的契约与黄金用例，跟着包一起走。
 *
 * 这个项目原本是 plugins/vitest.config.ts，随「plugins/ 里只剩独立子项目」的清理
 * 移到了仓库根；根 vitest.config.ts 用文件路径直接引用它（`projects` 接受具体
 * 配置文件路径）。别名也顺势指到新的发布清单位置 scripts/distributed-role-packs.ts。
 *
 * 数组形式的别名理由见 core/vitest.config.ts：`@plugins` 要精确匹配。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@core', replacement: resolve(import.meta.dirname, 'core/src') },
      { find: /^@plugins$/, replacement: resolve(import.meta.dirname, 'scripts/distributed-role-packs.ts') },
      { find: /^@plugins\//, replacement: `${resolve(import.meta.dirname, 'plugins')}/` },
    ],
  },
  test: {
    name: 'plugins',
    environment: 'node',
    include: ['plugins/*/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});