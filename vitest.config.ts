import { defineConfig } from 'vitest/config';

/**
 * 工作区测试入口：一次跑遍 core / desktop / plugins 三个包。
 *
 * 每个包自己那份 vitest.config.ts 管别名与 include，这里只负责编排。
 * 单进程跑三个包（而不是 `pnpm -r test` 分三次起 vitest）有两个好处：
 * 跨包的静态关卡（如 plugins/basePackage.test.ts 扫 core 与 desktop 的源码）
 * 在同一次运行里就能验完，失败报告也是一份。
 *
 * mobile 不在其中：它是独立安装的 npm 包，自带 vitest.config.mts，
 * 在 mobile/ 目录里跑。
 */
export default defineConfig({
  test: {
    projects: ['core', 'desktop', 'plugins'],
  },
});
