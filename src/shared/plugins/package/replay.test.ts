/**
 * 外置路径与内置路径的等价性。
 *
 * 判据不是「外置能跑」，而是「结果一模一样」。把每个内置插件过一遍包格式（序列化 →
 * 校验 → 解析 → 重放）装成第二个注册表，用同样的输入解析两次，descriptor 必须逐字相等，
 * configSnapshotHash 也不能差。差一个字节，跨端比对就失效——两台设备装的是同一份岗位包，
 * 一台走内置一台走外置，descriptor 却不同，同步层会当成配置漂移。
 */
import { describe, expect, it } from 'vitest';
import { DISTRIBUTED_ROLE_PACKS } from '../rolePacks';
import { BUILT_IN_CAPABILITY_PLUGINS } from '../builtin';
import { BuiltInPluginRegistry } from '../registry';
import { DeterministicRuntimeResolver } from '../resolver';
import type {
  ArtifactParserDefinition,
  CapabilityPlugin,
  HostRenderedInteraction,
  RolePack,
  ScopedToolDefinition,
} from '../types';
import {
  PACKAGE_CONTRIBUTIONS_FILE,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  parsePluginPackage,
  validatePluginPackage,
} from './contract';
import { toCapabilityPlugin } from './replay';

const CORE_VERSION = '1.0.0';

/** 从插件自己的兼容性声明里取，别写死数字：插件抬了 schema 要求，这个测试不该跟着改。 */
const SCHEMA_VERSION = Math.max(
  ...[
    ...DISTRIBUTED_ROLE_PACKS.map((pack) => pack.manifest),
    ...BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => plugin.manifest),
  ].map((manifest) => manifest.compatibility.schema),
);

interface Registrations {
  tools: ScopedToolDefinition[];
  artifactParsers: ArtifactParserDefinition[];
  interactions: HostRenderedInteraction[];
}

function record(plugin: CapabilityPlugin): Registrations {
  const registrations: Registrations = { tools: [], artifactParsers: [], interactions: [] };
  plugin.register({
    registerTool: (tool) => registrations.tools.push(tool),
    registerArtifactParser: (parser) => registrations.artifactParsers.push(parser),
    registerInteractionType: (interaction) => registrations.interactions.push(interaction),
  });
  return registrations;
}

/** 走一遍真实的磁盘格式：序列化、校验、解析。校验也要过，否则等价性建立在非法包上。 */
function throughPackage(files: Record<string, string>) {
  expect(validatePluginPackage(files)).toEqual([]);
  return parsePluginPackage(files);
}

function packagedRolePack(pack: RolePack): RolePack {
  const { manifest, ...rest } = pack;
  const parsed = throughPackage({
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
    [PACKAGE_PACK_FILE]: JSON.stringify(rest),
  });
  return parsed.rolePack!;
}

function packagedCapability(plugin: CapabilityPlugin): CapabilityPlugin {
  const parsed = throughPackage({
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin.manifest),
    [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify(record(plugin)),
  });
  return toCapabilityPlugin(parsed.manifest, parsed.contributions!);
}

function builtInRegistry(): BuiltInPluginRegistry {
  const registry = new BuiltInPluginRegistry();
  DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
  BUILT_IN_CAPABILITY_PLUGINS.forEach((plugin) => registry.registerCapability(plugin));
  return registry;
}

/** 同样的 id@version，但每个插件都是从包里读出来的。 */
function packagedRegistry(): BuiltInPluginRegistry {
  const registry = new BuiltInPluginRegistry();
  DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(packagedRolePack(pack)));
  BUILT_IN_CAPABILITY_PLUGINS.forEach((plugin) =>
    registry.registerCapability(packagedCapability(plugin)),
  );
  return registry;
}

describe('重放与原 register() 等价', () => {
  it.each(BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => [plugin.manifest.id, plugin] as const))(
    '%s 重放出的注册项与原插件逐条相同',
    (_id, plugin) => {
      const original = record(plugin);
      expect(record(packagedCapability(plugin))).toEqual(original);
      // 至少注册了一项，否则这条用例在比较两个空对象
      expect(
        original.tools.length + original.artifactParsers.length + original.interactions.length,
      ).toBeGreaterThan(0);
    },
  );

  it('manifest 过一遍包格式后不变', () => {
    for (const plugin of BUILT_IN_CAPABILITY_PLUGINS) {
      expect(packagedCapability(plugin).manifest).toEqual(plugin.manifest);
    }
  });
});

describe('解析结果与内置路径逐条一致', () => {
  const builtIn = new DeterministicRuntimeResolver(builtInRegistry());
  const packaged = new DeterministicRuntimeResolver(packagedRegistry());

  it.each(DISTRIBUTED_ROLE_PACKS.map((pack) => [pack.manifest.id, pack.manifest.id] as const))(
    '%s：两条路径解析出同一份 descriptor',
    (_label, rolePackId) => {
      const input = {
        coreVersion: CORE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        rolePackId,
        capabilityIds: [],
      };

      const left = builtIn.resolve(input);
      const right = packaged.resolve(input);

      expect(left.ok, JSON.stringify(left)).toBe(true);
      expect(right).toEqual(left);
    },
  );

  it('显式带上每个能力插件时也一致', () => {
    const input = {
      coreVersion: CORE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      rolePackId: DISTRIBUTED_ROLE_PACKS[0]!.manifest.id,
      capabilityIds: BUILT_IN_CAPABILITY_PLUGINS.map((plugin) => plugin.manifest.id),
    };

    const left = builtIn.resolve(input);

    // 带上能力插件才会真正走到 validateCapabilityRegistrations，也就是执行 register()
    expect(left.ok, JSON.stringify(left)).toBe(true);
    expect(packaged.resolve(input)).toEqual(left);
  });

  it('configSnapshotHash 在两条路径上相同', () => {
    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      const input = {
        coreVersion: CORE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        rolePackId: pack.manifest.id,
        capabilityIds: [],
      };
      const left = builtIn.resolve(input);
      const right = packaged.resolve(input);

      expect(left.ok && right.ok).toBe(true);
      if (!left.ok || !right.ok) return;
      expect(right.descriptor.configSnapshotHash).toBe(left.descriptor.configSnapshotHash);
      expect(right.descriptor.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('解析失败的输入在两条路径上给出同样的错误', () => {
    const input = {
      coreVersion: CORE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      rolePackId: 'no.such.pack',
      capabilityIds: [],
    };

    expect(packaged.resolve(input)).toEqual(builtIn.resolve(input));
  });
});
