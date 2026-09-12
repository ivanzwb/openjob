/**
 * 宿主能力注册表：内嵌能力声明（插入点 E）可以选用的全部能力。
 *
 * 三个能力的贡献契约（5 个 tool、1 个交互类型、1 个 artifact parser）与执行实现
 * 都长在宿主里；这张表是「包声明 id → 宿主重放贡献」的唯一索引。岗位包的
 * capabilities[] 只能引用这里的 id，manifest.permissions 必须等于所引用能力
 * 权限的并集（contracts 校验强制）——声明少于实现会漏授权，多于实现是凭空要权。
 */

import type { CapabilityPlugin } from './types';
import { analyticsCaseCapabilityPlugin } from './builtin/analyticsCase';
import { rolePlayCapabilityPlugin } from './builtin/rolePlay';
import { sourceRepositoryCapabilityPlugin } from './builtin/sourceRepository';

export const HOST_CAPABILITY_PLUGINS: ReadonlyMap<string, CapabilityPlugin> = new Map(
  [sourceRepositoryCapabilityPlugin, rolePlayCapabilityPlugin, analyticsCaseCapabilityPlugin].map(
    (plugin) => [plugin.manifest.id, plugin],
  ),
);
