/**
 * 代码插件的私有 KV 存储（§7.9 ctx.storage）。
 *
 * 每个 pluginId 一个 JSON 文件，放在 userData/plugin-storage/ 下，与主库物理隔离：
 * 插件拿不到连接，宿主也不必为插件数据建表。pluginId 进文件名，必须先过
 * 稳定 ID 规则（防路径穿越）；容量按插件限一个上限，防止无限膨胀。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { isStablePluginId } from '@core/plugins/contracts';

const MAX_KEYS_PER_PLUGIN = 500;
const MAX_VALUE_LENGTH = 64 * 1024;

function dir(): string {
  return join(app.getPath('userData'), 'plugin-storage');
}

function file(pluginId: string): string {
  if (!isStablePluginId(pluginId)) throw new Error(`插件 id 不合法：${pluginId}`);
  return join(dir(), `${pluginId}.json`);
}

function readAll(pluginId: string): Record<string, string> {
  const path = file(pluginId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeAll(pluginId: string, values: Record<string, string>): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(pluginId), JSON.stringify(values, null, 2), 'utf8');
}

export function pluginStorageGet(pluginId: string, key: string): string | null {
  return readAll(pluginId)[key] ?? null;
}

export function pluginStorageSet(pluginId: string, key: string, value: string): void {
  if (typeof key !== 'string' || !key) throw new Error('storage key 不能为空');
  if (typeof value !== 'string') throw new Error('storage value 必须是字符串');
  if (value.length > MAX_VALUE_LENGTH) throw new Error(`storage value 超过 ${MAX_VALUE_LENGTH} 字符上限`);
  const values = readAll(pluginId);
  const known = Object.keys(values);
  if (!(key in values) && known.length >= MAX_KEYS_PER_PLUGIN) {
    throw new Error(`插件存储键数量达到上限 ${MAX_KEYS_PER_PLUGIN}`);
  }
  values[key] = value;
  writeAll(pluginId, values);
}

export function pluginStorageDelete(pluginId: string, key: string): void {
  const values = readAll(pluginId);
  if (!(key in values)) return;
  delete values[key];
  if (Object.keys(values).length === 0) {
    rmSync(file(pluginId), { force: true });
    return;
  }
  writeAll(pluginId, values);
}
