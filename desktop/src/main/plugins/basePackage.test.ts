/**
 * 基础包保持岗位中立（v1.0 关卡）。
 *
 * `plugins/` 里的岗位包随 release 单独分发，基础包一行都不许引用它。这条退化最阴的地方
 * 是它不报错：谁在 `src/` 里 import 一下 `@plugins`，三个岗位包就被静态编译进基础包，
 * 而所有用例照样全绿，表现只是「装机就莫名带着三个岗位」。
 *
 * 两条保证互补：
 * - 物理：`desktop/electron.vite.config.ts` 的 main/preload/renderer 三个目标都不登记
 *   `@plugins` 别名，应用代码一旦引用，构建当场就断；
 * - 静态：这里扫源码，把违规定位到具体文件，而不是留一句「Rollup 解析不了 @plugins」。
 *
 * 别名那条得单独钉住：core 与 desktop 的 tsconfig 为了给测试与夹具解析路径必须登记
 * `@plugins`，于是 tsc 不会拦住应用代码的引用。构建配置是唯一挡住它的地方，
 * 谁「顺手补齐一下别名」就把这道墙拆了，且当时不会有任何失败。
 *
 * 这个关卡住在 `desktop/src/main/plugins/` 而不是仓库根：它守的是桌面端基础包的边界，
 * 跟旁边 v1ReleaseGate 这类发布关卡同住；`@plugins` 别名指向的发布清单在
 * `scripts/distributed-role-packs.ts`。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/** 岗位包的合法消费者：打包脚本、测试，以及只被测试引用的夹具。 */
function isTestOnly(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || file.includes('__fixtures__');
}

/** 递归收集一棵源码树里的非测试 .ts/.tsx。 */
function appSources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (isTestOnly(path)) continue;
      found.push(path);
    }
  };
  walk(root);
  return found;
}

describe('基础包不带岗位包', () => {
  it('应用源码（core、桌面端与手机端）没有一处 import 岗位包', () => {
    const roots = [
      join(REPO_ROOT, 'core', 'src'),
      join(REPO_ROOT, 'desktop', 'src'),
      join(REPO_ROOT, 'mobile', 'src'),
    ];
    const scanned = roots.flatMap((root) => appSources(root));
    // 扫不到文件的「全绿」是假绿：目录改名后这条用例会替所有人放行
    expect(scanned.length).toBeGreaterThan(100);

    const violations = scanned.filter((file) =>
      /from '@plugins(\/[^']*)?'/.test(readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('构建配置不登记 @plugins 别名，应用代码引用了就构建失败', () => {
    const config = readFileSync(join(REPO_ROOT, 'desktop', 'electron.vite.config.ts'), 'utf8');
    // 先剥注释：那个文件里有一段注释专门解释「这里为什么不登记 @plugins」，
    // 直接搜字符串会被自己的说明文档绊倒
    const code = config.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('@plugins');
  });
});