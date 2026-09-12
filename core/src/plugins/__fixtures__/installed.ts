/**
 * 「本机装了什么」的测试输入。
 *
 * 基础包只带能力插件，岗位包要用户自己装，于是 `installed` 不再有一个不言自明的默认值：
 * 传 `listBuiltInPlugins()` 表达的是「用户还没装任何岗位包」，那是空安装态的用例；要测
 * 装好之后的渲染与降级，就得把岗位包显式加进来。默认值省掉的那一步，恰好是这一版最容易
 * 判错的一步。
 */
import { coreCapabilitiesSuite, synthesizeSuiteFromRolePack } from '../capabilitySuite';
import type { RolePack } from '../types';
import { listBuiltInPlugins, toInstalledPlugin, type InstalledPlugin } from '../clientView';

/**
 * 能力合编包（源码仓库 + 角色扮演 + 案例拆解）的「本机已装」形态。
 *
 * 它曾经是三个随应用发布的内置能力，现在是一个单独安装的包；用例里凡是要表达
 * 「装了能力」的，都用这一条，而不是凭空造一个 InstalledPlugin。
 */
export const CAPABILITY_SUITE_INSTALLED: InstalledPlugin = toInstalledPlugin(
  coreCapabilitiesSuite.manifest,
);

/** 本机装了：能力合编包 + 给定岗位包（+ 空的内置清单）。 */
export function installedWith(...packs: readonly RolePack[]): InstalledPlugin[] {
  return [
    ...listBuiltInPlugins(),
    CAPABILITY_SUITE_INSTALLED,
    ...packs.flatMap((pack) => {
      // 插入点 E：带内嵌声明的岗位包会为合编包 id 合成一条与包同版本的清单项
      const suite = synthesizeSuiteFromRolePack(pack);
      const synthesized = suite ? [toInstalledPlugin(suite.manifest)] : [];
      return [toInstalledPlugin(pack.manifest), ...synthesized];
    }),
  ];
}

/** 只装了能力合编包、一个岗位包都没有的安装态。 */
export function installedCapabilitySuiteOnly(): InstalledPlugin[] {
  return [...listBuiltInPlugins(), CAPABILITY_SUITE_INSTALLED];
}
