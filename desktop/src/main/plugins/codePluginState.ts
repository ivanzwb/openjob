/**
 * 代码插件的启用状态（§13.4 准入第三层：用户确认）。
 *
 * 代码插件装上后默认**停用**——进程内直跑没有硬沙箱，「用户看过权限清单并点
 * 确认」是激活的必要条件。确认记录带时间戳，停用/再启用都会刷新，审计有据。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppPaths } from '../paths';
import { isStablePluginId } from '@core/plugins/contracts';

export interface CodePluginEnablement {
  enabled: boolean;
  /** 用户确认权限清单的时间；未确认过的插件不在表里 */
  confirmedAt: number;
}

function file(): string {
  return join(getAppPaths().userData, 'plugin-state.json');
}

function readAll(): Record<string, CodePluginEnablement> {
  const path = file();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, CodePluginEnablement>;
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, CodePluginEnablement>): void {
  writeFileSync(file(), JSON.stringify(map, null, 2), 'utf8');
}

/** 默认停用：没确认过权限的代码插件一律不激活 */
export function codePluginEnabled(pluginId: string): boolean {
  if (!isStablePluginId(pluginId)) return false;
  return readAll()[pluginId]?.enabled === true;
}

export function setCodePluginEnabled(pluginId: string, enabled: boolean): void {
  if (!isStablePluginId(pluginId)) throw new Error(`插件 id 不合法：${pluginId}`);
  const map = readAll();
  map[pluginId] = { enabled, confirmedAt: Date.now() };
  writeAll(map);
}
