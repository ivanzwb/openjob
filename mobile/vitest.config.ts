import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 手机端单元测试配置。
 *
 * 被测对象是 src/lib、src/llm/json.ts 等不依赖 RN 原生模块的纯逻辑。
 * 路径别名与 mobile/tsconfig.json 保持一致（@shared 指向桌面端共享目录）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'android', 'ios'],
  },
});