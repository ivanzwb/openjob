/**
 * 外置插件的隔离保障。
 *
 * 内置插件靠的是「源码里够不到宿主资源」（见 capabilityIsolation.test.ts）。外置插件
 * 没有源码树可扫，它的保障换了个形状，而且更强：**包里没有可执行的东西**。
 *
 * 这一条不能靠约定守住。只要有人在装载路径上加一句 import()，格式白名单再严也白搭——
 * 那时「外置插件不执行代码」就从事实退回成愿望。所以把它固定成关卡：装载路径上出现
 * 任何代码执行入口，这个文件就红。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_ALLOWED_FILES,
  PACKAGE_SIGNATURE_FILE,
} from '@shared/plugins/package/contract';
import { toCapabilityPlugin } from '@shared/plugins/package/replay';
import type { CapabilityRegistry } from '@shared/plugins/types';

/** 出现即视为「装载路径上能执行外部内容」的入口。 */
const EXECUTION_ENTRIES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bimport\s*\(/, reason: '动态 import' },
  { pattern: /\brequire\s*\(/, reason: 'require' },
  { pattern: /\beval\s*\(/, reason: 'eval' },
  { pattern: /new\s+Function\s*\(/, reason: 'new Function' },
  { pattern: /from 'node:vm'/, reason: 'node:vm' },
  { pattern: /utilityProcess/, reason: 'utilityProcess' },
  { pattern: /from 'node:child_process'/, reason: '子进程' },
  { pattern: /createRequire/, reason: 'createRequire' },
];

/** 外置插件从磁盘走到注册表要经过的全部模块。 */
const LOADER_FILES = [
  join(__dirname, 'inventory.ts'),
  join(__dirname, 'bootstrap.ts'),
  join(__dirname, 'install.ts'),
  join(__dirname, 'bundle.ts'),
  join(__dirname, 'runtime.ts'),
  join(__dirname, 'package', 'signature.ts'),
  join(__dirname, 'package', 'trustedKeys.ts'),
  join(__dirname, '..', '..', 'shared', 'plugins', 'package', 'contract.ts'),
  join(__dirname, '..', '..', 'shared', 'plugins', 'package', 'replay.ts'),
];

describe('装载路径上没有代码执行入口', () => {
  it('从磁盘到注册表的每个模块都不含 import()/require/eval/vm/子进程', () => {
    const violations: string[] = [];
    for (const file of LOADER_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const { pattern, reason } of EXECUTION_ENTRIES) {
        if (pattern.test(source)) violations.push(`${file} 出现了${reason}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('每个接触包内容的模块都在扫描清单里', () => {
    // 上一条用例的价值取决于清单够不够全。清单是手写的，所以这里反过来查：谁 import 了
    // 「包是什么」的定义（contract / replay），谁就在处理包内容，就必须被扫到。
    // 新加一个处理包数据的模块而忘了登记，这条会红。
    const scanned = new Set(LOADER_FILES.map((file) => file.toLowerCase()));
    const srcRoot = join(__dirname, '..', '..');
    const handlers = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      .map((entry) => join(srcRoot, entry))
      .filter((file) => /from '[^']*plugins\/package\/(contract|replay)'/.test(readFileSync(file, 'utf8')));

    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers.filter((file) => !scanned.has(file.toLowerCase()))).toEqual([]);
  });
});

describe('包格式承载不了代码', () => {
  it('白名单里只有 JSON 与签名文件，没有任何可执行扩展名', () => {
    for (const name of PACKAGE_ALLOWED_FILES) {
      if (name === PACKAGE_SIGNATURE_FILE) continue;
      expect(name, name).toMatch(/\.json$/);
    }
  });

  it('白名单是闭集合：新增文件名必须同步改这条用例', () => {
    // 白名单是整套隔离保障的地基，扩它必须是一个显式动作
    expect([...PACKAGE_ALLOWED_FILES].sort()).toEqual([
      'contributions.json',
      'manifest.json',
      'openjob.sig',
      'pack.json',
    ]);
  });
});

describe('贡献重放不执行包里的任何东西', () => {
  const manifest = {
    id: 'demo.cap',
    version: '1.0.0',
    type: 'capability' as const,
    displayName: 'Demo',
    description: 'Demo',
    compatibility: { core: '^1.0.0', schema: 1 },
    permissions: ['artifact:read' as const],
    runtime: { desktop: 'full' as const, mobile: 'full' as const },
  };

  function collect(contributions: Parameters<typeof toCapabilityPlugin>[1]) {
    const calls: string[] = [];
    const registry: CapabilityRegistry = {
      registerTool: (tool) => calls.push(`tool:${tool.name}`),
      registerArtifactParser: (parser) => calls.push(`parser:${parser.artifactType}`),
      registerInteractionType: (interaction) => calls.push(`interaction:${interaction.type}`),
    };
    toCapabilityPlugin(manifest, contributions).register(registry);
    return calls;
  }

  it('重放只调用 registry 的三个方法，顺序固定', () => {
    const calls = collect({
      interactions: [{ type: 'i1' } as never],
      tools: [{ name: 't1' } as never],
      artifactParsers: [{ artifactType: 'a1' } as never],
    });

    // 顺序不看对象键序：注册顺序会影响重复注册时的报错文案
    expect(calls).toEqual(['tool:t1', 'parser:a1', 'interaction:i1']);
  });

  it('声明里夹带看起来像代码的字符串也只是字符串', () => {
    const payload = 'process.exit(1)';
    const calls = collect({ tools: [{ name: payload, description: payload } as never] });

    expect(calls).toEqual([`tool:${payload}`]);
  });

  it('空 contributions 重放出零次调用，不抛错', () => {
    expect(collect({})).toEqual([]);
  });
});
