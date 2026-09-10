/**
 * 「本机装了什么」的测试输入。
 *
 * 基础包只带能力插件，岗位包要用户自己装，于是 `installed` 不再有一个不言自明的默认值：
 * 传 `listBuiltInPlugins()` 表达的是「用户还没装任何岗位包」，那是空安装态的用例；要测
 * 装好之后的渲染与降级，就得把岗位包显式加进来。默认值省掉的那一步，恰好是这一版最容易
 * 判错的一步。
 */
import type { RolePack } from '../types';
import { listBuiltInPlugins, toInstalledPlugin, type InstalledPlugin } from '../clientView';

export function installedWith(...packs: readonly RolePack[]): InstalledPlugin[] {
  return [...listBuiltInPlugins(), ...packs.map((pack) => toInstalledPlugin(pack.manifest))];
}
