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
  capabilityEntriesFromRolePack,
  rolePackDeclarationPlugin,
} from '@core/plugins/capabilityEntries';
import {
  DefaultDenyPermissionGateway,
  type CampaignCapabilityScope,
  type PermissionScopeProvider,
} from './permissionGateway';

/**
 * 每个能力一条权限契约，从岗位包的内嵌声明推导。
 *
 * 能力不是独立的包：契约按**能力自己的 id** 建，内容就是那条声明自己的权限并集——
 * 装一个岗位包等于授权它声明的那些能力，而不会顺带拿到别的能力。跨岗位的边界落在
 * descriptor 绑定层（战役启用与否）与宿主实现的按名分派上。
 */
const CAPABILITY_CONTRACTS: ReadonlyMap<string, ReadonlySet<PluginPermission>> = new Map(
  DISTRIBUTED_ROLE_PACKS.flatMap((pack) =>
    (pack.capabilities ?? []).map((declaration) => [
      declaration.id,
      new Set<PluginPermission>([
        ...(declaration.tools ?? []).map((tool) => tool.permission),
        ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
        ...(declaration.permissions ?? []),
      ]),
    ] as const),
  ),
);

/** 一切 Campaign 侧条件都放行，把变量收敛到「权限本身准不准」。 */
const OPEN_SCOPE: CampaignCapabilityScope = {
  campaignExists: true,
  capabilityEnabled: true,
  capabilityActive: true,
  resourceInScope: true,
};

function realGateway(
  contracts: ReadonlyMap<string, ReadonlySet<PluginPermission>> = CAPABILITY_CONTRACTS,
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

describe('权限契约来自岗位包的内嵌声明', () => {
  it('每个能力一条契约，等于该声明自己的权限并集', () => {
    const declaredIds = DISTRIBUTED_ROLE_PACKS.flatMap((pack) =>
      (pack.capabilities ?? []).map((declaration) => declaration.id),
    );
    expect(declaredIds.length).toBeGreaterThan(0);
    expect([...CAPABILITY_CONTRACTS.keys()].sort()).toEqual([...declaredIds].sort());

    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      for (const declaration of pack.capabilities ?? []) {
        const expected = [
          ...new Set([
            ...(declaration.tools ?? []).map((tool) => tool.permission),
            ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
            ...(declaration.permissions ?? []),
          ]),
        ].sort();
        expect([...CAPABILITY_CONTRACTS.get(declaration.id)!].sort(), declaration.id).toEqual(
          expected,
        );
      }
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
  it('每个能力拿得到且只拿得到它自己声明的权限', () => {
    for (const [capabilityId, declared] of CAPABILITY_CONTRACTS) {
      expect(declared.size, capabilityId).toBeGreaterThan(0);

      for (const permission of PLUGIN_PERMISSIONS) {
        const { decision } = authorize(capabilityId, permission);
        expect(decision.allowed, `${capabilityId} → ${permission}`).toBe(declared.has(permission));
      }
    }
  });

  it('某个能力有 repository:read，不代表另一个能力也能读仓库', () => {
    // 装岗位包 ≠ 所有能力都拿到全部权限：每条契约各管自己
    const withoutRepo = [...CAPABILITY_CONTRACTS].find(([, permissions]) =>
      !permissions.has('repository:read'),
    );
    expect(withoutRepo, '需要一个不含 repository:read 的能力做对照').toBeDefined();

    expect(authorize(withoutRepo![0], 'repository:read').decision).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });

  it('没安装的能力一律拒绝', () => {
    for (const capabilityId of ['not-installed-capability', 'source-repository@1.0.0']) {
      expect(authorize(capabilityId, 'repository:read').decision).toMatchObject({
        allowed: false,
        code: 'permission-undeclared',
      });
    }
  });

  it('越界请求在读 Campaign 状态之前就被拒', () => {
    // 先查库再拒等于让未授权的调用方也能触发一次数据库访问
    const { decision, resolve } = authorize('source-repository', 'artifact:write');
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

  it('内嵌声明是纯数据：派生的能力条目与重放视图都能原样 JSON 往返', () => {
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      // 条目里没有函数、类实例或句柄
      for (const entry of capabilityEntriesFromRolePack(pack)) {
        expect(JSON.parse(JSON.stringify(entry)), entry.id).toEqual(entry);
      }
      // 重放视图的 manifest 就是岗位包自己的 manifest，register 是函数
      const replay = rolePackDeclarationPlugin(pack);
      expect(JSON.parse(JSON.stringify(replay.manifest))).toEqual(replay.manifest);
      expect(typeof replay.register).toBe('function');
    }
  });
});
