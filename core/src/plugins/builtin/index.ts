/**
 * 内置插件清单——**已清空**。
 *
 * 原来这里随应用发布三个能力插件（sourceRepository / rolePlay / analyticsCase），
 * 现在它们合并为一个独立分发的能力包 `openjob-capabilities`（见
 * `../capabilitySuite.ts`），由 `scripts/pack-plugins.mjs` 打成 release 附件、
 * 用户按需安装。插件页从此没有「随应用发布」一栏，装了什么显示什么。
 *
 * 本目录的三个声明模块**继续保留**，两个用途：
 * - 工具/场景/交互的数据与结构是宿主实现的一部分（tools.ts、rolePlaySession.ts
 *   直接 import）；
 * - 打包脚本从它们录制 contributions，合成能力合编包。
 *
 * **岗位包不在这里**：基础包岗位中立，三个岗位包随 release 单独分发、由用户自己装
 * （见仓库顶层 `plugins/index.ts`）。
 */

import type { CapabilityPlugin, PluginManifest } from '../types';

/**
 * 随应用发布的插件：无。
 *
 * 导出保留为空集而不是删掉：clientView 的 listBuiltInPlugins、desktop runtime 的
 * createRegistry 等消费方按「内置清单（现为空）+ 本机安装清单」的模型工作，保留
 * 空集让这条链路继续成立，也保留「哪天要随包发某个能力」的回填位置。
 */
export const BUILT_IN_CAPABILITY_PLUGINS: readonly CapabilityPlugin[] = [];

export const BUILT_IN_PLUGIN_MANIFESTS: readonly PluginManifest[] =
  BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => plugin.manifest);
