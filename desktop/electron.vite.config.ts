import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// core 是同一个仓库里的 TypeScript 源码，不是编译好的包：三个目标都直接编译它，
// 不走 node_modules 里那条 workspace 软链。
// 路径按 cwd 解析——electron-vite 一律从 desktop/ 起（见 package.json 的 scripts）
const core = resolve('../core/src');

/**
 * 三个目标都不登记 `@plugins` 别名，这是有意的。
 *
 * 岗位包随 release 单独分发，应用代码一行都不许引用；别名不在这里，
 * 任何 `import ... from '@plugins'` 在构建时就解析失败。
 * plugins/basePackage.test.ts 会盯住这个文件里没有 @plugins。
 */
export default defineConfig({
  main: {
    // 原生模块（better-sqlite3）与 Node 依赖不能被打包，必须保持 external
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': core,
        '@main': resolve('src/main'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@core': core },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@core': core,
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});
