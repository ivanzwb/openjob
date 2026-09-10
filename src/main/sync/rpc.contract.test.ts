/**
 * 手机端 RPC 白名单与 IPC 契约的一致性。
 *
 * ipcContract.test.ts 已经守住「契约 ↔ main handler ↔ preload 白名单」三方；
 * 局域网 RPC 是第四处，漏登记时手机端只会在运行时拿到「RPC 通道未开放」。
 * 这里静态扫描 rpc.ts，把四处一起钉死。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_INVOKE_CHANNELS } from '@shared/ipc';

const ROOT = join(__dirname, '..', '..', '..');

/** T08 交付的运行时通道，手机端必须能调用 */
const RUNTIME_CHANNELS = [
  'plugin:listInstalled',
  // 岗位包移出基础包之后，手机端只能从配对的桌面取数据，漏登记这条它一个岗位包都拿不到
  'plugin:getRolePack',
  'campaign:getRuntimeDescriptor',
  'campaign:setRoleProfile',
  'campaign:getClientCapabilityView',
] as const;

function rpcWhitelist(): string[] {
  const src = readFileSync(join(__dirname, 'rpc.ts'), 'utf8');
  const start = src.indexOf('const RPC_HANDLERS');
  const end = src.indexOf('\n};', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/^ {2}'([^']+)':/gm)].map((match) => match[1]);
}

function mainHandledChannels(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'main', 'ipc', 'index.ts'), 'utf8');
  return [...src.matchAll(/\bhandle\(\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('RPC 白名单与契约一致', () => {
  it('白名单里的每个通道都在契约中登记过', () => {
    const contract = new Set<string>(IPC_INVOKE_CHANNELS);
    expect(rpcWhitelist().filter((channel) => !contract.has(channel))).toEqual([]);
  });

  it('运行时通道在契约、main handler、preload 白名单和 RPC 四处齐备', () => {
    const preload = readFileSync(join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
    const contract = new Set<string>(IPC_INVOKE_CHANNELS);
    const handled = new Set(mainHandledChannels());
    const rpc = new Set(rpcWhitelist());

    expect(preload).toMatch(/invokeAllowList = new Set<string>\(IPC_INVOKE_CHANNELS\)/);
    RUNTIME_CHANNELS.forEach((channel) => {
      expect(contract.has(channel), `契约缺少 ${channel}`).toBe(true);
      expect(handled.has(channel), `main 未注册 ${channel}`).toBe(true);
      expect(rpc.has(channel), `RPC 白名单缺少 ${channel}`).toBe(true);
    });
  });

  it('手机端不自带 resolver：RPC 只暴露 descriptor 与本机视图', () => {
    const src = readFileSync(join(__dirname, 'rpc.ts'), 'utf8');
    expect(src).not.toMatch(/DeterministicRuntimeResolver|@shared\/plugins\/resolver/);
  });
});
