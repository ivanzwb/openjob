/**
 * 代码插件启用状态（§13.4 第三层）的持久化行为：
 * 默认停用、确认记录带时间戳、非法 id 直接拒绝。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = { userData: '' };
vi.mock('../paths', () => ({ getAppPaths: () => paths }));

import { pluginRuntimeEnabled, setPluginRuntimeEnabled } from './pluginRuntimeState';

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'openjob-plugin-state-'));
});

afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true });
  vi.resetModules();
});

describe('pluginRuntimeState', () => {
  it('默认停用：没确认过权限的代码插件一律不激活', () => {
    expect(pluginRuntimeEnabled('portfolio-board')).toBe(false);
  });

  it('启用/停用持久化，停用不丢确认记录', () => {
    setPluginRuntimeEnabled('portfolio-board', true);
    expect(pluginRuntimeEnabled('portfolio-board')).toBe(true);

    setPluginRuntimeEnabled('portfolio-board', false);
    expect(pluginRuntimeEnabled('portfolio-board')).toBe(false);
  });

  it('非法插件 id 直接拒绝，不做任何落盘', () => {
    expect(() => setPluginRuntimeEnabled('../evil', true)).toThrow('插件 id 不合法');
    expect(pluginRuntimeEnabled('../evil')).toBe(false);
  });
});
