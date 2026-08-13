const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/**
 * 手机端有独立的依赖树（mobile/node_modules），所以桌面的 eslint.config.js 把 mobile/** 整体忽略，
 * 由这份配置单独跑。expo 官方配置负责 RN / Hermes 环境与 react-hooks，
 * 下面两条规则与桌面保持一致——src/shared 被两端同时加载，写法不该分叉。
 */
module.exports = defineConfig([
  globalIgnores(['.expo/**', 'dist/**', 'node_modules/**', 'src/db/migrations/bundle.ts']),

  expoConfig,

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]);
