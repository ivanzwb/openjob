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

import { PLUGIN_PERMISSIONS, type PluginPermission } from '@shared/plugins/permissions';
import { DISTRIBUTED_ROLE_PACKS } from '@shared/plugins/rolePacks';
import { BUILT_IN_CAPABILITY_PLUGINS } from '@shared/plugins/builtin';
import { ANALYTICS_CASE_CAPABILITY_ID } from '@shared/plugins/builtin/analyticsCase';
import { ROLE_PLAY_CAPABILITY_ID } from '@shared/plugins/builtin/rolePlay';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from '@shared/plugins/builtin/sourceRepository';
import {
  BUILT_IN_PERMISSION_CONTRACTS,
  DefaultDenyPermissionGateway,
  type CampaignCapabilityScope,
  type PermissionScopeProvider,
} from './permissionGateway';

/** 一切 Campaign 侧条件都放行，把变量收敛到「权限本身准不准」。 */
const OPEN_SCOPE: CampaignCapabilityScope = {
  campaignExists: true,
  capabilityEnabled: true,
  capabilityActive: true,
  resourceInScope: true,
};

function realGateway(
  contracts: ReadonlyMap<string, ReadonlySet<PluginPermission>> = BUILT_IN_PERMISSION_CONTRACTS,
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

const CAPABILITY_IDS = [
  SOURCE_REPOSITORY_CAPABILITY_ID,
  ROLE_PLAY_CAPABILITY_ID,
  ANALYTICS_CASE_CAPABILITY_ID,
] as const;

describe('权限契约来自内置清单', () => {
  it('每个内置能力插件都有一条契约，且逐字等于它声明的权限', () => {
    // 按内置清单推导而不是手写：手写时新插件会在网关这层被判成「没声明」，
    // 表现成能力装上了、界面开了、一取数据就失败
    expect([...BUILT_IN_PERMISSION_CONTRACTS.keys()].sort()).toEqual(
      BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => plugin.manifest.id).sort(),
    );

    for (const plugin of BUILT_IN_CAPABILITY_PLUGINS) {
      expect([...(BUILT_IN_PERMISSION_CONTRACTS.get(plugin.manifest.id) ?? [])].sort()).toEqual(
        [...plugin.manifest.permissions].sort(),
      );
    }
  });

  it('三个能力插件都在清单里', () => {
    for (const id of CAPABILITY_IDS) {
      expect(BUILT_IN_PERMISSION_CONTRACTS.has(id)).toBe(true);
    }
  });

  it('岗位包不申请任何权限', () => {
    // 岗位包只声明题目与量规；一旦它能申请权限，「岗位包不碰执行」这条边界就没了
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      expect(pack.manifest.permissions, pack.manifest.id).toEqual([]);
    }
  });
});

describe('声明的权限就是上限', () => {
  it.each(CAPABILITY_IDS)('%s 只拿得到自己声明的权限', (capabilityId) => {
    const declared = new Set(BUILT_IN_PERMISSION_CONTRACTS.get(capabilityId));
    expect(declared.size).toBeGreaterThan(0);

    for (const permission of PLUGIN_PERMISSIONS) {
      const { decision } = authorize(capabilityId, permission);
      expect(decision.allowed, `${capabilityId} → ${permission}`).toBe(declared.has(permission));
    }
  });

  it('一个能力插件借不到另一个的权限', () => {
    // 同一个 Campaign 里 source-repository 有 repository:read，
    // 不代表 role-play 也能读仓库
    expect(authorize(ROLE_PLAY_CAPABILITY_ID, 'repository:read').decision).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
    expect(authorize(SOURCE_REPOSITORY_CAPABILITY_ID, 'llm:complete').decision).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });

  it('analytics-case 只能读 artifact，碰不到模型、文件系统和网络', () => {
    expect(authorize(ANALYTICS_CASE_CAPABILITY_ID, 'artifact:read').decision.allowed).toBe(true);
    for (const permission of [
      'llm:complete',
      'filesystem:workspace',
      'network:fetch',
      'artifact:write',
    ] as const) {
      expect(
        authorize(ANALYTICS_CASE_CAPABILITY_ID, permission).decision,
        permission,
      ).toMatchObject({ allowed: false, code: 'permission-undeclared' });
    }
  });

  it('越界请求在读 Campaign 状态之前就被拒', () => {
    // 先查库再拒等于让未授权的调用方也能触发一次数据库访问
    const { decision, resolve } = authorize(ANALYTICS_CASE_CAPABILITY_ID, 'repository:read');
    expect(decision).toMatchObject({ allowed: false, code: 'permission-undeclared' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('清单里没有的插件一律拒绝', () => {
    expect(authorize('not-installed-capability', 'artifact:read').decision).toMatchObject({
      allowed: false,
      code: 'permission-undeclared',
    });
  });

  it('拒绝理由不带出资源标识', () => {
    const { decision } = authorize(ROLE_PLAY_CAPABILITY_ID, 'repository:read');
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
 * 岗位包移出基础包不代表这条边界可以松——它们仍然在这个仓库里写、在这里打包，装到用户
 * 机器上的是同一份数据。只扫 builtin 的话，岗位包那三个目录会静静地退出扫描范围，
 * 而这条用例照样全绿。
 */
const PLUGIN_ROOTS = [
  join(__dirname, '..', '..', 'shared', 'plugins', 'builtin'),
  join(__dirname, '..', '..', 'shared', 'plugins', 'rolePacks'),
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
        .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
        .map((entry) => join(root, directory.name, entry));
      byDirectory.set(directory.name, files);
    }
  }
  return byDirectory;
}

describe('插件够不到宿主资源', () => {
  it('插件源码里没有数据库、文件系统、模型 SDK 或环境变量的入口', () => {
    const byDirectory = pluginSourcesByDirectory();
    // 扫描范围要覆盖到每一个内置插件：漏掉哪个目录，这条用例就在替它放行
    expect(byDirectory.size).toBeGreaterThanOrEqual(
      DISTRIBUTED_ROLE_PACKS.length + BUILT_IN_CAPABILITY_PLUGINS.length,
    );
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
    for (const plugin of BUILT_IN_CAPABILITY_PLUGINS) {
      // Manifest 能原样 JSON 往返，说明里面没有函数、类实例或句柄
      expect(JSON.parse(JSON.stringify(plugin.manifest))).toEqual(plugin.manifest);
      expect(typeof plugin.register).toBe('function');
    }
  });
});
