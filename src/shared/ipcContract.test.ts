/**
 * IPC 契约回归防线。
 *
 * shared/ipc.ts 的通道清单是契约的唯一事实源，但契约本身不会阻止：
 * 1. main 注册了 handler 却忘了写进 IPC_INVOKE_CHANNELS —— renderer 永远调不到
 * 2. 通道写进了契约却没注册 handler —— 运行时才炸
 * 3. 契约改了一个通道名，main/preload 忘了同步 —— 静默失效
 *
 * 这里静态扫描 main 的注册代码与 preload 的白名单，与契约做三方一致性校验，
 * 任何一处不一致在 CI 里立刻红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from './ipc';

const ROOT = join(__dirname, '..', '..');

/** 递归收集 src/main 下所有 .ts 文件 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const mainFiles = collectTsFiles(join(ROOT, 'src', 'main'));

/** 从源码中提取 handle('channel') 的字面量 */
function extractHandledChannels(): string[] {
  const channels = new Set<string>();
  for (const file of mainFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bhandle\(\s*'([^']+)'/g)) channels.add(m[1]);
  }
  return [...channels];
}

/** 从源码中提取 emit('channel') 的字面量（event 单向推送） */
function extractEmittedChannels(): string[] {
  const channels = new Set<string>();
  for (const file of mainFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bemit\(\s*'([^']+)'/g)) channels.add(m[1]);
  }
  return [...channels];
}

describe('IPC 契约三方一致性', () => {
  it('每个契约通道都有 main 侧的 handler 注册（无「写了契约但没实现」）', () => {
    const handled = new Set<string>(extractHandledChannels());
    const missing = IPC_INVOKE_CHANNELS.filter((c) => !handled.has(c));
    expect(missing).toEqual([]);
  });

  it('每个 main 侧注册的 handler 都写进了契约（无「实现了但 renderer 调不到」）', () => {
    const contract = new Set<string>(IPC_INVOKE_CHANNELS);
    const extra = extractHandledChannels().filter((c) => !contract.has(c));
    expect(extra).toEqual([]);
  });

  it('每个契约事件通道都有 main 侧 emit（无「契约声明了但没人推送」）', () => {
    const emitted = new Set<string>(extractEmittedChannels());
    const missing = IPC_EVENT_CHANNELS.filter((c) => !emitted.has(c));
    expect(missing).toEqual([]);
  });

  it('每个 main 侧 emit 的事件都写进了契约', () => {
    const contract = new Set<string>(IPC_EVENT_CHANNELS);
    const extra = extractEmittedChannels().filter((c) => !contract.has(c));
    expect(extra).toEqual([]);
  });
});

describe('preload 白名单与契约一致', () => {
  it('preload 从契约构建放行名单，而不是硬编码', () => {
    const src = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
    expect(src).toContain('IPC_INVOKE_CHANNELS');
    expect(src).toContain('IPC_EVENT_CHANNELS');
    expect(src).toMatch(/invokeAllowList = new Set<string>\(IPC_INVOKE_CHANNELS\)/);
    expect(src).toMatch(/eventAllowList = new Set<string>\(IPC_EVENT_CHANNELS\)/);
  });

  it('preload 暴露的桥接方法名与 IpcBridge 契约一致', () => {
    const src = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
    // bridge 对象必须实现 invoke 与 on 两个入口
    expect(src).toMatch(/invoke<C extends IpcInvokeChannel>/);
    expect(src).toMatch(/on<C extends IpcEventChannel>/);
  });
});