/**
 * 本机降级视图的边界。
 *
 * 三条不变量：两端消费同一份 descriptor、降级只发生在视图层、
 * 认不出的 artifact schema 一律只读。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PLUGIN_MANIFESTS,
  buildClientCapabilityView,
  canParseArtifact,
  capabilityMode,
  listBuiltInPlugins,
  toInstalledPlugin,
  type InstalledPlugin,
} from './clientView';
import { softwareEngineeringRolePack } from './builtin/softwareEngineering';
import { sourceRepositoryCapabilityPlugin } from './builtin/sourceRepository';
import type { CampaignRuntimeDescriptor } from './types';

const ROLE_PACK_ID = softwareEngineeringRolePack.manifest.id;
const ROLE_PACK_VERSION = softwareEngineeringRolePack.manifest.version;
const REPO_ID = sourceRepositoryCapabilityPlugin.manifest.id;
const REPO_VERSION = sourceRepositoryCapabilityPlugin.manifest.version;

/**
 * artifact 版本协商用的反例插件，刻意取一个不会发布的 ID 与 artifact type。
 *
 * 这里原本用的是 `analytics-case`。它一旦真被实现，本机清单里就会出现同 ID
 * 的真插件，下面几条按 schemaVersion 2 写的断言会和真插件的版本打架——和本文件
 * 「本机完全没有该插件时区分出未安装」那条用例记下的是同一个坑。
 */
const PIVOT_LAB: InstalledPlugin = {
  id: 'pivot-lab',
  version: '1.0.0',
  type: 'capability',
  displayName: 'Pivot Lab',
  description: '虚构的透视表能力，只用于 artifact schema 协商测试',
  runtime: { desktop: 'full', mobile: 'full' },
  artifactSchemas: { 'pivot-table': 2 },
  interactionSchemas: {},
  permissions: ['artifact:read'],
};

function descriptor(
  overrides: Partial<CampaignRuntimeDescriptor> = {},
): CampaignRuntimeDescriptor {
  return {
    campaignId: 'c1',
    coreVersion: '1.0.0',
    rolePack: { id: ROLE_PACK_ID, version: ROLE_PACK_VERSION },
    capabilities: [{ id: REPO_ID, version: REPO_VERSION, enabled: true }],
    competencyBaselineVersion: ROLE_PACK_VERSION,
    configSnapshotHash: 'a'.repeat(64),
    resolvedAt: 1700000000000,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => deepFreeze(item));
    Object.freeze(value);
  }
  return value;
}

describe('本机安装清单', () => {
  it('由内置 Manifest 投影，按 ID 稳定排序', () => {
    const listed = listBuiltInPlugins();
    const ids = listed.map((plugin) => plugin.id);

    // 断言「投影 + 按 ID 排序」这两条性质，而不是逐个枚举：
    // 每新增一个内置插件都要回来改一次枚举，这条用例迟早被当成噪音顺手改掉
    expect(ids).toEqual([...ids].sort());
    expect(listed).toHaveLength(BUILT_IN_PLUGIN_MANIFESTS.length);
    expect(listed.map((plugin) => `${plugin.id}@${plugin.version}`)).toEqual(
      expect.arrayContaining([
        `${ROLE_PACK_ID}@${ROLE_PACK_VERSION}`,
        `${REPO_ID}@${REPO_VERSION}`,
      ]),
    );
  });

  it('岗位包不携带运行能力声明，能力插件必须携带', () => {
    expect(toInstalledPlugin(softwareEngineeringRolePack.manifest).runtime).toBeNull();
    expect(toInstalledPlugin(sourceRepositoryCapabilityPlugin.manifest).runtime).toEqual({
      desktop: 'full',
      mobile: 'view-only',
    });
  });
});

describe('两端共用同一份 descriptor', () => {
  it('视图层不引用 resolver / registry，客户端无法自行解析依赖', () => {
    const source = readFileSync(join(__dirname, 'clientView.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\/resolver'/);
    expect(source).not.toMatch(/from '\.\/registry'/);
  });

  it('桌面与手机得到相同的 hash 与能力集合，只有 mode 不同', () => {
    const input = { descriptor: descriptor(), installed: listBuiltInPlugins() };
    const desktop = buildClientCapabilityView({ ...input, platform: 'desktop' });
    const mobile = buildClientCapabilityView({ ...input, platform: 'mobile' });

    expect(mobile.configSnapshotHash).toBe(desktop.configSnapshotHash);
    expect(mobile.resolvedAt).toBe(desktop.resolvedAt);
    expect(mobile.capabilities.map((item) => item.id)).toEqual(
      desktop.capabilities.map((item) => item.id),
    );
    expect(capabilityMode(desktop, REPO_ID)).toBe('full');
    expect(capabilityMode(mobile, REPO_ID)).toBe('view-only');
    expect(mobile.readOnlyCapabilityIds).toEqual([REPO_ID]);
    expect(mobile.degraded).toBe(true);
    expect(desktop.degraded).toBe(false);
  });

  it('descriptor 中不存在的能力一律按不可用处理，不按 ID 猜测', () => {
    const view = buildClientCapabilityView({
      descriptor: descriptor(),
      platform: 'desktop',
      installed: [...listBuiltInPlugins(), PIVOT_LAB],
    });

    expect(capabilityMode(view, PIVOT_LAB.id)).toBe('unsupported');
  });
});

describe('降级不修改 Campaign binding', () => {
  it('输入 descriptor 与安装清单在计算后逐字未变', () => {
    const frozen = deepFreeze(descriptor());
    const installed = deepFreeze(listBuiltInPlugins());
    const before = JSON.stringify(frozen);

    const view = buildClientCapabilityView({
      descriptor: frozen,
      platform: 'mobile',
      installed,
    });

    expect(JSON.stringify(frozen)).toBe(before);
    // 视图只复述 descriptor 里的精确版本，不会改写绑定
    expect(view.capabilities[0]).toMatchObject({ id: REPO_ID, version: REPO_VERSION });
  });

  it('固定版本不可用时降级为只读，而不是改用其它版本', () => {
    const view = buildClientCapabilityView({
      descriptor: descriptor({
        capabilities: [{ id: REPO_ID, version: '9.9.9', enabled: true }],
      }),
      platform: 'desktop',
      installed: listBuiltInPlugins(),
    });

    expect(view.capabilities[0]).toMatchObject({
      version: '9.9.9',
      installed: false,
      mode: 'view-only',
      reason: 'pinned-version-unavailable',
    });
    expect(view.degraded).toBe(true);
  });

  it('本机完全没有该插件时区分出未安装', () => {
    const view = buildClientCapabilityView({
      descriptor: descriptor({
        // 用一个不会发布的虚构 ID：拿真实的待实现插件当反例，
        // 等它真被实现出来（role-play 就是这么失效的）这个用例会莫名转红。
        capabilities: [{ id: 'never-shipped-capability', version: '1.0.0', enabled: true }],
      }),
      platform: 'desktop',
      installed: listBuiltInPlugins(),
    });

    expect(view.capabilities[0]).toMatchObject({
      mode: 'view-only',
      reason: 'plugin-not-installed',
    });
  });

  it('descriptor 已禁用的能力不计入本机降级', () => {
    const view = buildClientCapabilityView({
      descriptor: descriptor({
        capabilities: [
          { id: REPO_ID, enabled: false, disabledReason: 'plugin-not-found: 插件未安装' },
        ],
      }),
      platform: 'desktop',
      installed: listBuiltInPlugins(),
    });

    expect(view.capabilities[0]).toMatchObject({
      mode: 'unsupported',
      reason: 'capability-disabled',
    });
    expect(view.capabilities[0].detail).toContain('plugin-not-found');
    expect(view.degraded).toBe(false);
  });

  it('岗位包固定版本不可用时整个 Campaign 只读', () => {
    const view = buildClientCapabilityView({
      descriptor: descriptor({ rolePack: { id: ROLE_PACK_ID, version: '0.9.0' } }),
      platform: 'desktop',
      installed: listBuiltInPlugins(),
    });

    expect(view.rolePack.mode).toBe('view-only');
    expect(view.degraded).toBe(true);
  });
});

describe('未知 artifact schema 只读', () => {
  const withPivotLab = descriptor({
    capabilities: [
      { id: REPO_ID, version: REPO_VERSION, enabled: true },
      { id: PIVOT_LAB.id, version: PIVOT_LAB.version, enabled: true },
    ],
  });
  const installed = [...listBuiltInPlugins(), PIVOT_LAB];

  it('本机已知且版本不高于本机时才允许解析', () => {
    const view = buildClientCapabilityView({
      descriptor: withPivotLab,
      platform: 'desktop',
      installed,
      artifacts: [
        { capabilityId: PIVOT_LAB.id, artifactType: 'pivot-table', schemaVersion: 1 },
        { capabilityId: PIVOT_LAB.id, artifactType: 'pivot-table', schemaVersion: 2 },
      ],
    });

    expect(view.artifacts.map((item) => item.parsable)).toEqual([true, true]);
    expect(view.artifacts[0]).toMatchObject({ knownSchemaVersion: 2, reason: null });
    expect(view.degraded).toBe(false);
  });

  it('更高的 schema 版本降级为只读，不尝试解析', () => {
    const view = buildClientCapabilityView({
      descriptor: withPivotLab,
      platform: 'desktop',
      installed,
      artifacts: [
        { capabilityId: PIVOT_LAB.id, artifactType: 'pivot-table', schemaVersion: 3 },
      ],
    });

    expect(view.artifacts[0]).toMatchObject({
      knownSchemaVersion: 2,
      parsable: false,
      reason: 'artifact-schema-unknown',
    });
    expect(view.degraded).toBe(true);
    expect(
      canParseArtifact(view, {
        capabilityId: PIVOT_LAB.id,
        artifactType: 'pivot-table',
        schemaVersion: 3,
      }),
    ).toBe(false);
  });

  it('本机完全不认识的 artifact type 同样只读', () => {
    const view = buildClientCapabilityView({
      descriptor: withPivotLab,
      platform: 'desktop',
      installed,
      artifacts: [
        { capabilityId: PIVOT_LAB.id, artifactType: 'slide-deck', schemaVersion: 1 },
      ],
    });

    expect(view.artifacts[0]).toMatchObject({
      knownSchemaVersion: null,
      parsable: false,
      reason: 'artifact-schema-unknown',
    });
  });

  it('固定版本不可用时不读本机其它版本声明的 schema', () => {
    const view = buildClientCapabilityView({
      descriptor: descriptor({
        capabilities: [{ id: PIVOT_LAB.id, version: '2.0.0', enabled: true }],
      }),
      platform: 'desktop',
      installed,
      artifacts: [
        { capabilityId: PIVOT_LAB.id, artifactType: 'pivot-table', schemaVersion: 1 },
      ],
    });

    expect(view.artifacts[0]).toMatchObject({
      knownSchemaVersion: null,
      parsable: false,
      reason: 'pinned-version-unavailable',
    });
  });
});
