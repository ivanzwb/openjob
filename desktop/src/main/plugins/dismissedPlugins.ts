/**
 * 用户卸载过的插件记录。
 *
 * 唯一的用途是让**随安装包分发的默认插件**可卸载：它启动时会自动装上，如果不记住
 * 「用户主动删掉了它」，下一次启动就会把它装回来——那不叫默认，叫删不掉。
 *
 * 记录的是卸载过的 id，而不是某一个写死的岗位包 id：基础包不认识任何岗位（见
 * hostUi/roleNeutralGate），这条规则对任何随包分发的默认插件都成立。
 *
 * 这是设备本地属性（换台机器本来就该重新按默认来），不进同步、也不写进 config：
 * 它只描述「这台机器上用户做过什么」，与业务数据无关。文件坏掉时按「没卸载过」处理，
 * 方向与 trustedKeys 一致——宁可让默认插件装回来，也不要因为一个坏文件改变启动行为。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAppPaths } from '../paths';

const FILE_NAME = 'dismissed-plugins.json';

function dismissalFile(): string {
  return join(getAppPaths().userData, FILE_NAME);
}

export function dismissedPluginIds(path = dismissalFile()): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { dismissed?: unknown };
    if (!Array.isArray(parsed.dismissed)) return new Set();
    return new Set(parsed.dismissed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

/** 记下「这个包是用户主动卸载的」。重复记录是幂等的。 */
export function dismissPlugin(id: string, path = dismissalFile()): void {
  const ids = dismissedPluginIds(path);
  if (ids.has(id)) return;
  ids.add(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ dismissed: [...ids].sort() }, null, 2)}\n`, 'utf8');
}
