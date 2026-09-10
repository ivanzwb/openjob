import { describe, expect, it } from 'vitest';
import type {
  CapabilityPlugin,
  CapabilityRegistry,
  PluginDependency,
  PluginManifest,
  RolePack,
} from './types';
import { BuiltInPluginRegistry, PluginRegistrationError } from './registry';
import {
  DeterministicRuntimeResolver,
  satisfiesSemVerRange,
  sha256,
} from './resolver';

function manifest(
  id: string,
  version: string,
  type: PluginManifest['type'],
  options: {
    dependencies?: PluginDependency[];
    core?: string;
    schema?: number;
    permissions?: PluginManifest['permissions'];
  } = {},
): PluginManifest {
  return {
    id,
    version,
    type,
    displayName: id,
    description: `${id} test plugin`,
    compatibility: {
      core: options.core ?? '^1.0.0',
      schema: options.schema ?? 1,
    },
    permissions: options.permissions ?? [],
    runtime:
      type === 'capability' ? { desktop: 'full', mobile: 'view-only' } : undefined,
    dependencies: options.dependencies,
  };
}

function rolePack(
  version = '1.0.0',
  dependencies: PluginDependency[] = [],
  id = 'test-role',
): RolePack {
  return {
    manifest: manifest(id, version, 'role-pack', { dependencies }),
    roleMatchers: [{ titlePatterns: ['test'] }],
    competencyTemplates: [
      {
        id: 'test.competency',
        name: '测试能力',
        category: 'knowledge',
        description: '测试能力描述',
        defaultWeight: 1,
        levelIndicators: [{ level: 3, behavior: '能够完成测试任务' }],
        evidenceKinds: ['skill'],
        supportedFormats: ['test.knowledge'],
      },
    ],
    interviewStages: [
      {
        id: 'test.stage',
        label: '测试阶段',
        order: 0,
        formatIds: ['test.knowledge'],
        defaultWeight: 1,
      },
    ],
    interviewFormats: [
      {
        id: 'test.knowledge',
        label: '测试问答',
        protocol: 'knowledge',
        defaultDurationMinutes: 30,
        followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
        rubricId: 'test.rubric',
      },
    ],
    rubrics: [
      {
        id: 'test.rubric',
        dimensions: [
          {
            id: 'accuracy',
            label: '准确性',
            weight: 1,
            anchors: {
              1: '错误',
              2: '部分错误',
              3: '基本正确',
              4: '完整正确',
              5: '完整并能解释边界',
            },
          },
        ],
      },
    ],
    taskTemplates: [
      {
        id: 'test.learn',
        label: '学习',
        taskKind: 'learn',
        defaultMinutes: 30,
        supportedFormats: ['test.knowledge'],
      },
    ],
    promptFragments: { diagnosis: '执行测试岗位诊断。' },
    sourcePolicy: { preferredDomains: [] },
  };
}

function capability(
  id: string,
  version = '1.0.0',
  options: {
    dependencies?: PluginDependency[];
    core?: string;
    schema?: number;
    permissions?: PluginManifest['permissions'];
    register?: (registry: CapabilityRegistry) => void;
  } = {},
): CapabilityPlugin {
  return {
    manifest: manifest(id, version, 'capability', options),
    register: options.register ?? (() => undefined),
  };
}

function resolverWith(
  role: RolePack,
  capabilities: CapabilityPlugin[] = [],
): DeterministicRuntimeResolver {
  const registry = new BuiltInPluginRegistry();
  registry.register(role);
  capabilities.forEach((plugin) => registry.registerCapability(plugin));
  return new DeterministicRuntimeResolver(registry);
}

const BASE_INPUT = {
  coreVersion: '1.0.0',
  schemaVersion: 1,
  rolePackId: 'test-role',
  capabilityIds: [] as string[],
};

describe('BuiltInPluginRegistry', () => {
  it('按 SemVer 返回最高版本，也支持精确版本读取', () => {
    const registry = new BuiltInPluginRegistry();
    registry.register(rolePack('1.0.0'));
    registry.register(rolePack('1.2.0'));
    registry.register(rolePack('1.1.0'));

    expect(registry.get('test-role')?.manifest.version).toBe('1.2.0');
    expect(registry.get('test-role', '1.0.0')?.manifest.version).toBe('1.0.0');
    expect(registry.list().map((pack) => pack.manifest.version)).toEqual([
      '1.0.0',
      '1.1.0',
      '1.2.0',
    ]);
  });

  it('拒绝相同 id/version 覆盖', () => {
    const registry = new BuiltInPluginRegistry();
    registry.register(rolePack());
    expect(() => registry.register(rolePack())).toThrow(PluginRegistrationError);
  });

  it('注册时快照并冻结数据，调用方后续修改不会破坏索引', () => {
    const registry = new BuiltInPluginRegistry();
    const pack = rolePack();
    registry.register(pack);
    pack.manifest.version = '9.9.9';

    expect(registry.get('test-role')?.manifest.version).toBe('1.0.0');
    expect(registry.get('test-role', '9.9.9')).toBeNull();
  });
});

describe('DeterministicRuntimeResolver', () => {
  it('相同语义输入跨调用产生完全相同的 descriptor 和 SHA-256 hash', () => {
    const resolver = resolverWith(rolePack(), [
      capability('cap.alpha'),
      capability('cap.beta'),
    ]);
    const first = resolver.resolve({
      ...BASE_INPUT,
      capabilityIds: ['cap.beta', 'cap.alpha'],
    });
    const second = resolver.resolve({
      ...structuredClone(BASE_INPUT),
      capabilityIds: ['cap.alpha', 'cap.beta'],
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (first.ok) {
      expect(first.descriptor.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.descriptor.capabilities.map((item) => item.id)).toEqual([
        'cap.alpha',
        'cap.beta',
      ]);
    }
  });

  it('SemVer 优先级相同时使用完整版本字符串消除注册顺序差异', () => {
    const makeResolver = (versions: string[]) => {
      const registry = new BuiltInPluginRegistry();
      registry.register(rolePack('1.0.0', [{ id: 'cap.build', version: '1.0.0' }]));
      versions.forEach((version) =>
        registry.registerCapability(capability('cap.build', version)),
      );
      return new DeterministicRuntimeResolver(registry);
    };
    const first = makeResolver(['1.0.0+desktop', '1.0.0+mobile']).resolve(BASE_INPUT);
    const second = makeResolver(['1.0.0+mobile', '1.0.0+desktop']).resolve(BASE_INPUT);

    expect(first).toEqual(second);
    expect(first.ok && first.descriptor.capabilities[0]?.version).toBe('1.0.0+mobile');
  });

  it('选择最高兼容版本，并服从 Campaign 固定版本', () => {
    const registry = new BuiltInPluginRegistry();
    registry.register(rolePack('1.0.0', [{ id: 'cap.source', version: '^1.0.0' }]));
    registry.registerCapability(capability('cap.source', '1.0.0'));
    registry.registerCapability(capability('cap.source', '1.5.0'));
    const resolver = new DeterministicRuntimeResolver(registry);

    const latest = resolver.resolve(BASE_INPUT);
    const pinned = resolver.resolve({
      ...BASE_INPUT,
      pinnedVersions: { 'cap.source': '1.0.0' },
    });

    expect(latest.ok && latest.descriptor.capabilities[0]?.version).toBe('1.5.0');
    expect(pinned.ok && pinned.descriptor.capabilities[0]?.version).toBe('1.0.0');
  });

  it('最高版本的依赖不可满足时回溯到可完整激活的较低版本', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.source', version: '*' }]),
      [
        capability('cap.source', '1.0.0'),
        capability('cap.source', '2.0.0', {
          dependencies: [{ id: 'cap.missing', version: '^1.0.0' }],
        }),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok && result.descriptor.capabilities).toEqual([
      { id: 'cap.source', version: '1.0.0', enabled: true },
    ]);
  });

  it('最高版本注册冲突时回溯到可注册的较低版本', () => {
    const registerTool = (registry: CapabilityRegistry) =>
      registry.registerTool({
        name: 'shared-tool',
        description: '测试工具',
        permission: 'llm:complete',
        inputSchemaVersion: 1,
      });
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'cap.base', version: '1.0.0' },
        { id: 'cap.variant', version: '*' },
      ]),
      [
        capability('cap.base', '1.0.0', {
          permissions: ['llm:complete'],
          register: registerTool,
        }),
        capability('cap.variant', '1.0.0'),
        capability('cap.variant', '2.0.0', {
          permissions: ['llm:complete'],
          register: registerTool,
        }),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toContainEqual({
        id: 'cap.variant',
        version: '1.0.0',
        enabled: true,
      });
    }
  });

  it('必需依赖缺失时只返回结构化错误，不返回部分 descriptor', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.required', version: '^1.0.0' }]),
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'plugin-not-found',
        pluginId: 'cap.required',
      }),
    });
    expect('descriptor' in result).toBe(false);
  });

  it('可选依赖缺失时保留主配置并记录稳定 disabledReason', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'cap.optional', version: '^1.0.0', optional: true },
      ]),
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toEqual([
        {
          id: 'cap.optional',
          enabled: false,
          disabledReason: expect.stringContaining('plugin-not-found'),
        },
      ]);
    }
  });

  it('检测必需依赖环并返回完整环路径', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.a', version: '^1.0.0' }]),
      [
        capability('cap.a', '1.0.0', {
          dependencies: [{ id: 'cap.b', version: '^1.0.0' }],
        }),
        capability('cap.b', '1.0.0', {
          dependencies: [{ id: 'cap.a', version: '^1.0.0' }],
        }),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'dependency-cycle',
        dependencyPath: ['cap.a', 'cap.b', 'cap.a'],
      }),
    });
  });

  it('检测多个必需依赖对同一插件的版本冲突', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'cap.shared', version: '^1.0.0' },
        { id: 'cap.consumer', version: '^1.0.0' },
      ]),
      [
        capability('cap.shared', '1.5.0'),
        capability('cap.shared', '2.0.0'),
        capability('cap.consumer', '1.0.0', {
          dependencies: [{ id: 'cap.shared', version: '^2.0.0' }],
        }),
      ],
    );

    expect(resolver.resolve(BASE_INPUT)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'version-conflict',
        pluginId: 'cap.shared',
      }),
    });
  });

  it('区分 Core 与 schema 不兼容错误', () => {
    const coreResolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.future', version: '1.0.0' }]),
      [capability('cap.future', '1.0.0', { core: '^2.0.0' })],
    );
    const schemaResolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.future', version: '1.0.0' }]),
      [capability('cap.future', '1.0.0', { schema: 2 })],
    );

    expect(coreResolver.resolve(BASE_INPUT)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'core-incompatible' }),
    });
    expect(schemaResolver.resolve(BASE_INPUT)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'schema-incompatible' }),
    });
  });

  it('注册项冲突导致整次激活失败', () => {
    const registerDuplicate = (registry: CapabilityRegistry) =>
      registry.registerTool({
        name: 'duplicate-tool',
        description: '测试工具',
        permission: 'llm:complete',
        inputSchemaVersion: 1,
      });
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'cap.a', version: '1.0.0' },
        { id: 'cap.b', version: '1.0.0' },
      ]),
      [
        capability('cap.a', '1.0.0', {
          permissions: ['llm:complete'],
          register: registerDuplicate,
        }),
        capability('cap.b', '1.0.0', {
          permissions: ['llm:complete'],
          register: registerDuplicate,
        }),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-manifest',
        message: expect.stringContaining('重复注册'),
      }),
    });
    expect('descriptor' in result).toBe(false);
  });

  it('可选插件注册冲突时只禁用该插件', () => {
    const registerDuplicate = (registry: CapabilityRegistry) =>
      registry.registerTool({
        name: 'shared-tool',
        description: '测试工具',
        permission: 'llm:complete',
        inputSchemaVersion: 1,
      });
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'cap.required', version: '1.0.0' },
        { id: 'cap.optional', version: '1.0.0', optional: true },
      ]),
      [
        capability('cap.required', '1.0.0', {
          permissions: ['llm:complete'],
          register: registerDuplicate,
        }),
        capability('cap.optional', '1.0.0', {
          permissions: ['llm:complete'],
          register: registerDuplicate,
        }),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toEqual([
        {
          id: 'cap.optional',
          enabled: false,
          disabledReason: expect.stringContaining('invalid-manifest'),
        },
        { id: 'cap.required', version: '1.0.0', enabled: true },
      ]);
    }
  });

  it('多个可选来源共同约束同一插件时联合选择兼容版本', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'zzz.consumer', version: '1.0.0' },
        { id: 'cap.shared', version: '>=1.0.0 <3.0.0', optional: true },
      ]),
      [
        capability('zzz.consumer', '1.0.0', {
          dependencies: [{ id: 'cap.shared', version: '^1.0.0', optional: true }],
        }),
        capability('cap.shared', '1.0.0'),
        capability('cap.shared', '2.0.0'),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toContainEqual({
        id: 'cap.shared',
        version: '1.0.0',
        enabled: true,
      });
    }
  });

  it('互斥的可选版本范围禁用插件而不保留部分激活', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'zzz.consumer', version: '1.0.0' },
        { id: 'cap.shared', version: '^1.0.0', optional: true },
      ]),
      [
        capability('zzz.consumer', '1.0.0', {
          dependencies: [{ id: 'cap.shared', version: '^2.0.0', optional: true }],
        }),
        capability('cap.shared', '1.0.0'),
        capability('cap.shared', '2.0.0'),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toContainEqual(
        expect.objectContaining({
          id: 'cap.shared',
          enabled: false,
          disabledReason: expect.stringContaining('version-conflict'),
        }),
      );
      expect(
        result.descriptor.capabilities.some(
          (item) => item.id === 'cap.shared' && item.enabled,
        ),
      ).toBe(false);
    }
  });

  it('可选依赖的固定版本仍必须满足声明范围', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.optional', version: '^1.0.0', optional: true }]),
      [
        capability('cap.optional', '1.0.0'),
        capability('cap.optional', '2.0.0'),
      ],
    );
    const result = resolver.resolve({
      ...BASE_INPUT,
      pinnedVersions: { 'cap.optional': '2.0.0' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toContainEqual(
        expect.objectContaining({
          id: 'cap.optional',
          enabled: false,
          disabledReason: expect.stringContaining('version-conflict'),
        }),
      );
    }
  });

  it('可选回滚后移除已不可达插件产生的禁用记录', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [
        { id: 'zzz.consumer', version: '1.0.0' },
        { id: 'cap.optional', version: '^1.0.0', optional: true },
      ]),
      [
        capability('zzz.consumer', '1.0.0', {
          dependencies: [{ id: 'cap.optional', version: '^2.0.0', optional: true }],
        }),
        capability('cap.optional', '1.0.0', {
          dependencies: [{ id: 'cap.stale', version: '1.0.0', optional: true }],
        }),
        capability('cap.optional', '2.0.0'),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities.some((item) => item.id === 'cap.stale')).toBe(false);
      expect(result.descriptor.capabilities).toContainEqual(
        expect.objectContaining({ id: 'cap.optional', enabled: false }),
      );
    }
  });

  it('可选依赖最高版本成环时回溯到无环的较低版本', () => {
    const resolver = resolverWith(
      rolePack('1.0.0', [{ id: 'cap.base', version: '1.0.0' }]),
      [
        capability('cap.base', '1.0.0', {
          dependencies: [{ id: 'cap.optional', version: '*', optional: true }],
        }),
        capability('cap.optional', '1.0.0'),
        capability('cap.optional', '2.0.0', {
          dependencies: [{ id: 'cap.base', version: '1.0.0', optional: true }],
        }),
      ],
    );
    const result = resolver.resolve(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.capabilities).toContainEqual({
        id: 'cap.optional',
        version: '1.0.0',
        enabled: true,
      });
    }
  });
});

describe('SemVer and hash primitives', () => {
  it('支持精确、caret、tilde、比较器、通配符和 OR 范围', () => {
    expect(satisfiesSemVerRange('1.5.0', '^1.0.0')).toBe(true);
    expect(satisfiesSemVerRange('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesSemVerRange('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesSemVerRange('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesSemVerRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemVerRange('1.9.0', '1.x')).toBe(true);
    expect(satisfiesSemVerRange('2.0.0', '1.x || 2.x')).toBe(true);
    expect(satisfiesSemVerRange('1.5.0-beta.1', '^1.0.0')).toBe(false);
    expect(satisfiesSemVerRange('1.2.1', '>1.2')).toBe(false);
    expect(satisfiesSemVerRange('1.3.0', '>1.2')).toBe(true);
    expect(satisfiesSemVerRange('1.3.5', '1.2 - 1.3')).toBe(true);
    expect(satisfiesSemVerRange('0.9.0', '^0')).toBe(true);
    expect(satisfiesSemVerRange('1.0.0', '^0.x')).toBe(false);
    expect(satisfiesSemVerRange('1.2.3-beta.2', '1.2.3-beta.1 - 1.2.3')).toBe(true);
    expect(satisfiesSemVerRange('1.2.3-beta.1', '*')).toBe(false);
  });

  it('SHA-256 实现与标准向量一致且支持 UTF-8', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256('通用面试')).toMatch(/^[a-f0-9]{64}$/);
  });
});
