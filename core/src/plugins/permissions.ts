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
  'microphone:read',
  // 写入宿主的话术库（用户自己的演讲/话术收藏）。来源取值由包自己起，权限词本身
  // 不含任何岗位含义——它只说「这个包可以把一段文字存进用户的话术库」。
  'library:write',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}
