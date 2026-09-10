/**
 * Capability 插件可申请的最小权限集合。
 *
 * 权限只表达“可以向 Core 网关发起请求”，不直接暴露数据库、模型 SDK、
 * API Key、文件系统或 IPC。Role/Industry Pack 的 permissions 必须为空。
 */
export const PLUGIN_PERMISSIONS = [
  'evidence:read-confirmed',
  'evidence:propose',
  'artifact:read',
  'artifact:write',
  'network:search',
  'network:fetch',
  'llm:complete',
  'filesystem:workspace',
  'repository:read',
  'microphone:read',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}
