/**
 * 随应用发布的内置插件清单，唯一事实源。
 *
 * 之前这份清单散在三处：`clientView.ts` 的安装清单、`src/main/plugins/runtime.ts`
 * 的解析注册表和 `src/main/practice/rolePack.ts` 的练习查找表。三处都要手动补一行，
 * 漏掉任意一处都不会报错，只会表现成「岗位包能选但练不了」或「练得了但不在安装
 * 清单里，于是整个 Campaign 被判成只读」——都是排查成本远高于改动成本的故障。
 * 新增内置插件现在只改这一处。
 */

import type { CapabilityPlugin, PluginManifest, RolePack } from '../types';
import { analyticsCaseCapabilityPlugin } from './analyticsCase';
import { productManagerRolePack } from './productManager';
import { rolePlayCapabilityPlugin } from './rolePlay';
import { salesCustomerSuccessRolePack } from './salesCustomerSuccess';
import { softwareEngineeringRolePack } from './softwareEngineering';
import { sourceRepositoryCapabilityPlugin } from './sourceRepository';

export const BUILT_IN_ROLE_PACKS: readonly RolePack[] = [
  softwareEngineeringRolePack,
  productManagerRolePack,
  salesCustomerSuccessRolePack,
];

export const BUILT_IN_CAPABILITY_PLUGINS: readonly CapabilityPlugin[] = [
  sourceRepositoryCapabilityPlugin,
  rolePlayCapabilityPlugin,
  analyticsCaseCapabilityPlugin,
];

export const BUILT_IN_PLUGIN_MANIFESTS: readonly PluginManifest[] = [
  ...BUILT_IN_ROLE_PACKS.map((pack) => pack.manifest),
  ...BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => plugin.manifest),
];
