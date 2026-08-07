import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 单包结构靠 lint 规则维持分层，替代把 main/renderer/shared 拆成三个包的物理隔离。
 * 核心约束只有三条，但每条被突破都会直接损伤架构：
 *   1. 渲染进程不得接触 Node / Electron 主进程能力，只能走 preload 白名单
 *   2. shared 必须保持纯类型与常量，不能引入任何运行时 I/O
 *   3. main 不得反向依赖渲染进程代码
 */
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'src/main/db/migrations/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
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

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'fs', 'path', 'child_process'],
              message: '渲染进程不能直接使用 Node / Electron API，请通过 window.api 走 IPC。',
            },
            {
              group: ['**/main/**', '@main/*'],
              message: '渲染进程不能导入主进程代码，共享内容请放到 src/shared。',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'fs', 'path', 'child_process', 'better-sqlite3', 'openai'],
              message: 'shared 只放类型与常量，不能包含运行时 I/O——它同时被主进程和渲染进程加载。',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/renderer/**', '@renderer/*'],
              message: '主进程不能依赖渲染进程代码。',
            },
          ],
        },
      ],
    },
  },
);
