import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 手机端单元测试配置。
 *
 * 被测对象是 src/lib、src/llm/json.ts 等不依赖 RN 原生模块的纯逻辑。
 * 路径别名与 mobile/tsconfig.json 保持一致（@shared 指向桌面端共享目录）。
 *
 * 扩展名用 .mts 而不是 .ts：mobile/package.json 不能声明 type: module（Expo 与
 * Metro 的工具链按 CommonJS 解析），于是 .ts 配置会被当 CommonJS 加载，撞上这里
 * 的 ESM 语法就会告警——Vite 未来会把原生 config loader 设为默认，那时更是硬性
 * 要求。桌面端根 package.json 有 type: module，所以那边的 .ts 配置无此问题。
 *
 * 同理不能再用 __dirname：原生 ESM 下它不存在，改用 import.meta.dirname。
 */
export default defineConfig({
  resolve: {
    // 数组形式的理由见桌面端 vitest.config.ts：`@plugins` 得精确匹配
    alias: [
      { find: '@shared', replacement: resolve(import.meta.dirname, '../src/shared') },
      { find: /^@plugins$/, replacement: resolve(import.meta.dirname, '../plugins/index.ts') },
      { find: /^@plugins\//, replacement: `${resolve(import.meta.dirname, '../plugins')}/` },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'android', 'ios'],
  },
});
