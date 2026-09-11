import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 分层现在主要靠物理边界，lint 只补物理挡不住的那部分。
 *
 * 拆成 core / desktop / plugins 三个包之后：
 *   - core 的 package.json 里 dependencies 为空，`import better-sqlite3` 在 pnpm 的
 *     严格 node_modules 下根本解析不到——原来那条「shared 必须保持纯类型与常量」的
 *     lint 规则，现在有了装不上就跑不起来的执行方式；
 *   - core 与 desktop 是两个包，core 想 import 主进程代码得先声明依赖，反向依赖
 *     会立刻显形在 package.json 上。
 *
 * 物理边界挡不住的还剩两条，仍然由这里守：
 *   1. 渲染进程与主进程同属 desktop 包，包管理器分不开它们——渲染进程不得接触
 *      Node / Electron 能力，只能走 preload 白名单；主进程不得反向依赖渲染进程。
 *   2. core 里的 node:* 与 electron：这些是 Node 内置或 peer，不出现在 dependencies 里，
 *      空依赖拦不住，只能靠规则。
 */
export default tseslint.config(
  {
    ignores: [
      '**/out/**',
      '**/dist/**',
      'dist-*/**',
      'export/**',
      '**/node_modules/**',
      'desktop/src/main/db/migrations/**',
      'mobile/**',
    ],
  },

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
    // 构建脚本跑在 Node 里，不走 tsconfig 的 lib 配置
    files: ['scripts/**/*.mjs', 'desktop/scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },

  {
    files: ['desktop/src/renderer/**/*.{ts,tsx}'],
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
              message: '渲染进程不能导入主进程代码，共享内容请放到 core。',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'fs', 'path', 'child_process', 'better-sqlite3', 'openai'],
              message: 'core 只放类型与常量，不能包含运行时 I/O——它同时被 Electron 与 Metro 编译。',
            },
          ],
        },
      ],
    },
  },

  {
    // 测试文件不是 shipped 代码，允许做源码静态扫描所需的 I/O
    // （如 ipcContract.test.ts 读取 main/preload 源码做三方一致性校验）
    files: ['core/src/**/*.test.ts', 'plugins/**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  {
    files: ['desktop/src/main/**/*.ts'],
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
