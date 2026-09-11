import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 岗位包自带的契约与黄金用例，跟着包一起走。
 *
 * 数组形式的别名理由见 core/vitest.config.ts：`@plugins` 要精确匹配。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@core', replacement: resolve(import.meta.dirname, '../core/src') },
      { find: /^@plugins$/, replacement: resolve(import.meta.dirname, 'index.ts') },
      { find: /^@plugins\//, replacement: `${resolve(import.meta.dirname)}/` },
    ],
  },
  test: {
    name: 'plugins',
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules'],
  },
});
