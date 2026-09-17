/**
 * 「本机装了什么」的测试输入。
 *
 * 能力随岗位包分发：装了哪些包就决定了有哪些能力。所以夹具按同一条规则派生——用生产路径
 * 那个 `capabilityEntriesFromRolePack`，而不是手搓能力条目。手搓能通过，说明不了生产路径
 * 也对。
 *
 * 基础包不带任何插件，于是 `installed` 没有不言自明的默认值：给空数组表达的是「用户还没装
 * 任何岗位包」（连能力也一并没有），要测装好之后的渲染与降级，就得把岗位包显式传进来。
 */
import { capabilityEntriesFromRolePack } from '../capabilityEntries';
import type { RolePack } from '../types';
import { listBuiltInPlugins, toInstalledPlugin, type InstalledPlugin } from '../clientView';

/** 本机装了：给定岗位包 + 它们内嵌声明派生的能力条目（+ 空的内置清单）。 */
export function installedWith(...packs: readonly RolePack[]): InstalledPlugin[] {
  return [
    ...listBuiltInPlugins(),
    ...packs.flatMap((pack) => [
      toInstalledPlugin(pack.manifest),
      ...capabilityEntriesFromRolePack(pack),
    ]),
  ];
}

/** 一个岗位包都没装：能力随包来，所以能力也一并没有。 */
export function installedWithoutPacks(): InstalledPlugin[] {
  return [...listBuiltInPlugins()];
}
