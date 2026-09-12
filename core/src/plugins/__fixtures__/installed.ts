/**
 * 「本机装了什么」的测试输入。
 *
 * 基础包只带能力插件，岗位包要用户自己装，于是 `installed` 不再有一个不言自明的默认值：
 * 传 `listBuiltInPlugins()` 表达的是「用户还没装任何岗位包」，那是空安装态的用例；要测
 * 装好之后的渲染与降级，就得把岗位包显式加进来。默认值省掉的那一步，恰好是这一版最容易
 * 判错的一步。
 */
import { synthesizeSuiteFromRolePack } from '../capabilitySuite';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import type { RolePack } from '../types';
import { listBuiltInPlugins, toInstalledPlugin, type InstalledPlugin } from '../clientView';

/**
 * 能力合编包（源码仓库 + 角色扮演 + 案例拆解）的「本机已装」形态。
 *
 * 它曾经是三个随应用发布的内置能力，现在是一个单独安装的包；用例里凡是要表达
 * 「装了能力」的，都用这一条，而不是凭空造一个 InstalledPlugin。
 */
/** 合编包的「本机已装」形态：从 SE 包内嵌声明合成。
 * 同时保留 legacy 1.0.0 版本条目——历史 descriptor pin 的是退役 id@1.0.0，
 * 归一后要按这个版本判定 installed，否则回填窗口内会误判 plugin-not-installed。 */
export const CAPABILITY_SUITE_INSTALLED: InstalledPlugin = toInstalledPlugin(
  synthesizeSuiteFromRolePack(softwareEngineeringRolePack)!.manifest,
);
export const CAPABILITY_SUITE_LEGACY_INSTALLED: InstalledPlugin = {
  ...CAPABILITY_SUITE_INSTALLED,
  version: '1.0.0',
};

/** 本机装了：能力合编包 + 给定岗位包（+ 空的内置清单）。 */
export function installedWith(...packs: readonly RolePack[]): InstalledPlugin[] {
  return [
    ...listBuiltInPlugins(),
    // legacy 1.0.0 条目：历史 descriptor pin 的是退役 id@1.0.0，归一后按它判 installed
    CAPABILITY_SUITE_LEGACY_INSTALLED,
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
  return [...listBuiltInPlugins(), CAPABILITY_SUITE_INSTALLED, CAPABILITY_SUITE_LEGACY_INSTALLED];
}
