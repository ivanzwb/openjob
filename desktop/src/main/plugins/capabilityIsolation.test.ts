/**
 * 三个能力插件的权限隔离（v1.0 关卡）。
 *
 * 两条互补的保证：
 * - 运行期：Manifest 声明的权限就是上限，越界一律在查 Campaign 状态之前被拒；
 * - 静态：插件源码里根本没有数据库、文件系统、模型 SDK 和环境变量的入口，
 *   所以「插件绕过网关自己去拿」这条路不是靠约定守住的，而是不存在。
 *
 * 静态那半边尤其重要：网关只拦经过它的请求，拦不住一个 import 了 better-sqlite3
 * 的插件。真正的边界是插件够不到那些东西。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  getDb: vi.fn(),
  schema: {},
}));

import { PLUGIN_PERMISSIONS, type PluginPermission } from '@core/plugins/permissions';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import {
  CORE_CAPABILITIES_PACK_ID,
  RETIRED_CAPABILITY_KEYS,
  synthesizeSuiteFromRolePack,
} from '@core/plugins/capabilitySuite';
import {
  DefaultDenyPermissionGateway,
  type CampaignCapabilityScope,
  type PermissionScopeProvider,
} from './permissionGateway';

/**
 * 能力合编包的权限契约。
 *
 * 三个能力并入一个包后，manifest 声明的权限是三者并集——「每个能力一份最小契约」
 * 的隔离升级为「一个包一份并集契约」：用户装这个包，等于一次性授权这四项权限。
 * 单能力的边界退到 descriptor 绑定层（战役启用与否）与宿主实现的按名分派。
 */
// 合编包契约按「合成条目的版本」登记：每个版本的权限 = 该版本岗位包内嵌声明的并集；
// 独立分发的旧套件（1.0.0）保留全量四项权限的兼容契约。
const SUITE_CONTRACTS: ReadonlyMap<string, ReadonlySet<PluginPermission>> = new Map([
  [CORE_CAPABILITIES_PACK_ID, new Set(['repository:read', 'llm:complete', 'microphone:read', 'artifact:read'])],
]);

/** 一切 Campaign 侧条件都放行，把变量收敛到「权限本身准不准」。 */
const OPEN_SCOPE: CampaignCapabilityScope = {
  campaignExists: true,
  capabilityEnabled: true,
  capabilityActive: true,
  resourceInScope: true,
};

function realGateway(
  contracts: ReadonlyMap<string, ReadonlySet<PluginPermission>> = SUITE_CONTRACTS,
) {
  const resolve = vi.fn((): CampaignCapabilityScope => OPEN_SCOPE);
  const provider: PermissionScopeProvider = { resolve };
  return {
    gateway: new DefaultDenyPermissionGateway(provider, () => contracts),
    resolve,
  };
}

function authorize(capabilityId: string, permission: PluginPermission) {
  const { gateway, resolve } = realGateway();
  const decision = gateway.authorize({
    campaignId: 'campaign-a',
    capabilityId,
    permission,
    resource: { kind: 'repository', id: 'repo-secret-a' },
  });
  return { decision, resolve };
}

describe('权限契约来自安装清单', () => {
  it('能力合编包有一条契约，等于岗位包内嵌声明权限的并集', () => {
    const declared = SUITE_CONTRACTS.get(CORE_CAPABILITIES_PACK_ID);
    expect(declared).toBeDefined();
    const fromPacks = [
      ...new Set(
        DISTRIBUTED_ROLE_PACKS.flatMap((pack) => [
          ...(pack.capabilities ?? []).flatMap((declaration) => [
            ...(declaration.tools ?? []).map((tool) => tool.permission),
            ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
            ...(declaration.permissions ?? []),
          ]),
        ]),
      ),
    ].sort();
    expect([...declared!].sort()).toEqual(fromPacks);
  });

  it('三个退役 id 不在契约里：旧内置身份不能再被借用', () => {
    // 契约按已安装包推导，而合编包用的是新 id；旧 id@1.0.0 同时在 reserved
    // 名册里（见 runtime.ts 的 builtInPluginKeys），装都装不进来
    for (const key of RETIRED_CAPABILITY_KEYS) {
      const id = key.split('@')[0]!;
      expect(SUITE_CONTRACTS.has(id)).toBe(false);
    }
  });

  it('岗位包权限等于内嵌能力权限的并集，不允许凭空多要', () => {
    // 插入点 E：权限随内嵌能力声明走，并集由宿主注册表推导（contracts 强制）
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      const expected = [
        ...new Set([
          ...pack.capabilities.flatMap((declaration) => [
            ...(declaration.tools ?? []).map((tool) => tool.permission),
            ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
            ...(declaration.permissions ?? []),
          ]),
        ]),
      ].sort();
      expect(pack.manifest.permissions, pack.manifest.id).toEqual(expected);
    }
  });
});

describe('声明的权限就是上限', () => {
  it('合编包拿得到且只拿得到它声明的权限', () => {
    const declared = new Set(SUITE_CONTRACTS.get(CORE_CAPABILITIES_PACK_ID));
    expect(declared.size).toBeGreaterThan(0);

    for (const permission of PLUGIN_PERMISSIONS) {
      const { decision } = authorize(CORE_CAPABILITIES_PACK_ID, permission);
      expect(decision.allowed, `${CORE_CAPABILITIES_PACK_ID} → ${permission}`).toBe(
        declared.has(permission),
      );
    }
  });

  it('没安装的能力一律拒绝，包括三个退役 id', () => {
    // 同一个 Campaign 里合编包有 repository:read，
    // 不代表一个未安装的旧能力 id 也能读仓库
    for (const capabilityId of ['not-installed-capability', ...RETIRED_CAPABILITY_KEYS.map((key) => key.split('@')[0]!)]) {
      expect(authorize(capabilityId, 'repository:read').decision).toMatchObject({
        allowed: false,
        code: 'permission-undeclared',
      });
    }
  });

  it('越界请求在读 Campaign 状态之前就被拒', () => {
    // 先查库再拒等于让未授权的调用方也能触发一次数据库访问
    const { decision, resolve } = authorize(CORE_CAPABILITIES_PACK_ID, 'artifact:write');
    expect(decision).toMatchObject({ allowed: false, code: 'permission-undeclared' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('越界请求在读 Campaign 状态之前就被拒', () => {
    // 先查库再拒等于让未授权的调用方也能触发一次数据库访问
    const { decision, resolve } = authorize(CORE_CAPABILITIES_PACK_ID, 'artifact:write');
    expect(decision).toMatchObject({ allowed: false, code: 'permission-undeclared' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('拒绝理由不带出资源标识', () => {
    const { decision } = authorize('not-installed-capability', 'repository:read');
    expect(JSON.stringify(decision)).not.toContain('repo-secret-a');
  });
});

/** 插件源码里出现即视为越界的入口。 */
const FORBIDDEN_SOURCE_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /from '(node:fs|node:fs\/promises)'/, reason: '文件系统' },
  { pattern: /from 'node:child_process'/, reason: '子进程' },
  { pattern: /from '(node:http|node:https|node:net)'/, reason: '网络' },
  { pattern: /from 'better-sqlite3'/, reason: '数据库驱动' },
  { pattern: /from 'drizzle-orm/, reason: '数据库访问层' },
  { pattern: /from 'openai'/, reason: '模型 SDK' },
  { pattern: /from 'electron'/, reason: '宿主进程' },
  { pattern: /process\.env/, reason: '环境变量（API Key 就在这里）' },
  { pattern: /from '.*\/main\//, reason: '主进程内部模块' },
];

/**
 * 两个根都要扫：能力插件随应用发布，岗位包随 release 单独发布。
 *
 * 岗位包移出基础包（现在住在仓库顶层 plugins/，和 mobile/ 平级）不代表这条边界可以
 * 松——它们仍然在这个仓库里写、在这里打包，装到用户机器上的是同一份数据。只扫 builtin
 * 的话，岗位包那三个目录会静静地退出扫描范围，而这条用例照样全绿。
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PLUGIN_ROOTS = [
  // 声明归包所有：静态扫描的「插件源码」就是仓库里的岗位包目录
  join(REPO_ROOT, 'plugins'),
];

/** 插件目录 → 该目录下的非测试源码。 */
function pluginSourcesByDirectory(): Map<string, string[]> {
  const byDirectory = new Map<string, string[]>();
  for (const root of PLUGIN_ROOTS) {
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const files = readdirSync(join(root, directory.name), {
        recursive: true,
        encoding: 'utf8',
      })
        .filter(
          (entry) =>
            // TS 声明与 JS 入口/资产脚本都是插件源码，都在扫描范围内
            (entry.endsWith('.ts') || entry.endsWith('.js')) &&
            !entry.endsWith('.test.ts'),
        )
        .map((entry) => join(root, directory.name, entry));
      byDirectory.set(directory.name, files);
    }
  }
  return byDirectory;
}

describe('插件够不到宿主资源', () => {
  it('插件源码里没有数据库、文件系统、模型 SDK 或环境变量的入口', () => {
    const byDirectory = pluginSourcesByDirectory();
    // 扫描范围要覆盖到每一个插件目录：漏掉哪个目录，这条用例就在替它放行
    expect(byDirectory.size).toBeGreaterThanOrEqual(DISTRIBUTED_ROLE_PACKS.length);
    for (const [directory, files] of byDirectory) {
      expect(files.length, `${directory} 没有扫到源码`).toBeGreaterThan(0);
    }

    const violations: string[] = [];
    for (const files of byDirectory.values()) {
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const { pattern, reason } of FORBIDDEN_SOURCE_PATTERNS) {
          if (pattern.test(source)) violations.push(`${file} 引用了${reason}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('能力插件是纯声明：只导出数据与 register，不含运行期副作用', () => {
    for (const plugin of DISTRIBUTED_ROLE_PACKS.filter((pack) => pack.manifest.main).map(
      (pack) => synthesizeSuiteFromRolePack(pack)!,
    )) {
      // Manifest 能原样 JSON 往返，说明里面没有函数、类实例或句柄
      expect(JSON.parse(JSON.stringify(plugin.manifest))).toEqual(plugin.manifest);
      expect(typeof plugin.register).toBe('function');
    }
  });
});
