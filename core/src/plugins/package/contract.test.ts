/**
 * 包格式校验。
 *
 * 主判据是「内置插件序列化成外置包之后仍然合法」：这一条同时证明格式能承载真实的
 * 岗位包与能力声明，以及序列化过程没有丢东西。剩下的用例都在证伪——每一条都是
 * 一种真实的坏包。
 */
import { describe, expect, it } from 'vitest';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { productManagerRolePack } from '@plugins/productManager';
import { salesCustomerSuccessRolePack } from '@plugins/salesCustomerSuccess';
import type {
  ArtifactParserDefinition,
  CapabilityDeclaration,
  CapabilityPlugin,
  HostRenderedInteraction,
  RolePack,
  ScopedToolDefinition,
} from '../types';
import {
  PACKAGE_CONTRIBUTIONS_FILE,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_PACK_FILE,
  PACKAGE_SIGNATURE_FILE,
  parsePluginPackage,
  type PluginPackageContributions,
  type PluginPackageFiles,
  validatePluginPackage,
} from './contract';

function rolePackFiles(pack: RolePack): Record<string, string> {
  const { manifest, ...rest } = pack;
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
    [PACKAGE_PACK_FILE]: JSON.stringify(rest),
  };
}

/** 录一遍 register() 推给 registry 的东西，就是这个插件的 contributions。 */
function recordContributions(plugin: CapabilityPlugin): PluginPackageContributions {
  const tools: ScopedToolDefinition[] = [];
  const artifactParsers: ArtifactParserDefinition[] = [];
  const interactions: HostRenderedInteraction[] = [];
  plugin.register({
    registerTool: (tool) => tools.push(tool),
    registerArtifactParser: (parser) => artifactParsers.push(parser),
    registerInteractionType: (interaction) => interactions.push(interaction),
  });
  return { tools, artifactParsers, interactions };
}

function capabilityFiles(plugin: CapabilityPlugin): Record<string, string> {
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin.manifest),
    [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify(recordContributions(plugin)),
  };
}

function paths(files: PluginPackageFiles): string[] {
  return validatePluginPackage(files).map((issue) => issue.path);
}

/**
 * 把一条能力声明包成一个独立能力包。
 *
 * 基础包不再内置能力包（能力随岗位包分发），但能力包这个类型还在；格式用例需要
 * 「声明里有什么」的真实素材，所以直接从岗位包的内嵌声明里取一条来包。
 */
function declarationPlugin(id: string, declaration: CapabilityDeclaration): CapabilityPlugin {
  const artifactSchemas: Record<string, number> = {};
  for (const parser of declaration.artifactParsers ?? []) {
    artifactSchemas[parser.artifactType] = parser.schemaVersion;
  }
  const interactionSchemas: Record<string, number> = {};
  for (const interaction of declaration.interactions ?? []) {
    interactionSchemas[interaction.type] = interaction.schemaVersion;
  }

  return {
    manifest: {
      id,
      version: '1.0.0',
      type: 'capability',
      displayName: id,
      description: '格式用例：把一条能力声明单独打成能力包',
      compatibility: { core: '^1.0.0', schema: 24 },
      permissions: [
        ...new Set([
          ...(declaration.tools ?? []).map((tool) => tool.permission),
          ...(declaration.artifactParsers ?? []).map((parser) => parser.permission),
          ...(declaration.permissions ?? []),
        ]),
      ].sort(),
      runtime: { desktop: 'full', mobile: 'view-only' },
      ...(Object.keys(artifactSchemas).length > 0 ? { artifactSchemas } : {}),
      ...(Object.keys(interactionSchemas).length > 0 ? { interactionSchemas } : {}),
    },
    register(registry) {
      for (const tool of declaration.tools ?? []) registry.registerTool(tool);
      for (const parser of declaration.artifactParsers ?? []) registry.registerArtifactParser(parser);
      for (const interaction of declaration.interactions ?? []) {
        registry.registerInteractionType(interaction);
      }
    },
  };
}

const SE_CAPABILITY = declarationPlugin(
  'demo-source-repository',
  softwareEngineeringRolePack.capabilities[0]!,
);
const PM_CAPABILITY = declarationPlugin(
  'demo-analytics-case',
  productManagerRolePack.capabilities[0]!,
);
const SALES_CAPABILITY = declarationPlugin(
  'demo-role-play',
  salesCustomerSuccessRolePack.capabilities[0]!,
);

describe('插件包格式', () => {
  it('每个内置岗位包序列化成外置包后都合法，且解析回来一字不差', () => {
    expect(DISTRIBUTED_ROLE_PACKS.length).toBeGreaterThan(0);

    for (const pack of DISTRIBUTED_ROLE_PACKS) {
      const files = rolePackFiles(pack);
      expect(validatePluginPackage(files), pack.manifest.id).toEqual([]);
      // JSON 往返之后必须与内置对象完全相等，否则外置包和内置包的行为会有暗差
      expect(parsePluginPackage(files).rolePack, pack.manifest.id).toEqual(pack);
    }
  });

  it('能力包（manifest + contributions）序列化后仍然合法', () => {
    const files = capabilityFiles(SE_CAPABILITY);
    expect(validatePluginPackage(files)).toEqual([]);
    expect(parsePluginPackage(files).contributions).toEqual(recordContributions(SE_CAPABILITY));
  });

  it('包里出现白名单外的文件一律拒装', () => {
    const pack = DISTRIBUTED_ROLE_PACKS[0]!;

    // 白名单而不是黑名单：夹带可执行载荷的唯一入口就是「包里多一个文件」
    for (const name of ['plugin.mjs', 'index.js', 'postinstall.sh', 'nested/evil.json']) {
      expect(paths({ ...rolePackFiles(pack), [name]: 'whatever' }), name).toContain(name);
    }
  });

  it('签名文件不算未知文件', () => {
    const files = { ...rolePackFiles(DISTRIBUTED_ROLE_PACKS[0]!), [PACKAGE_SIGNATURE_FILE]: '{}' };

    expect(validatePluginPackage(files)).toEqual([]);
  });

  it('缺 manifest 或 manifest 不是合法 JSON 都直接判死', () => {
    expect(paths({})).toEqual([PACKAGE_MANIFEST_FILE]);
    expect(paths({ [PACKAGE_MANIFEST_FILE]: '{ not json' })).toEqual([PACKAGE_MANIFEST_FILE]);
  });

  it('岗位包缺 pack.json 或带了 contributions.json 都不合法', () => {
    const pack = DISTRIBUTED_ROLE_PACKS[0]!;
    const { [PACKAGE_PACK_FILE]: _pack, ...withoutPack } = rolePackFiles(pack);

    expect(paths(withoutPack)).toContain(PACKAGE_PACK_FILE);
    expect(
      paths({ ...rolePackFiles(pack), [PACKAGE_CONTRIBUTIONS_FILE]: '{"tools":[]}' }),
    ).toContain(PACKAGE_CONTRIBUTIONS_FILE);
  });

  it('能力插件声明了 manifest 里没写的权限时拒装', () => {
    // 这条声明的 manifest 只含 repository:read：改权限到 microphone:read 后
    // 与 manifest 不一致才会被拒
    const plugin = SE_CAPABILITY;

    const contributions = recordContributions(plugin!);
    contributions.tools![0]!.permission = 'microphone:read';
    const files = {
      [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin!.manifest),
      [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify(contributions),
    };

    // manifest 没声明就放过的话，装上之后才在解析期炸，用户拿到的是一句无从下手的报错
    expect(paths(files)).toContain('contributions.tools[0].permission');
  });

  it('能力插件一项都不声明时拒装', () => {
    const plugin = SE_CAPABILITY;

    expect(
      paths({
        [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin.manifest),
        [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify({ tools: [] }),
      }),
    ).toContain(PACKAGE_CONTRIBUTIONS_FILE);
  });

  it('artifact parser 的版本必须与 manifest.artifactSchemas 对齐', () => {
    const plugin = [PM_CAPABILITY].find(
      (item) => recordContributions(item).artifactParsers!.length > 0,
    );
    expect(plugin, '需要一个注册了 artifact parser 的能力包').toBeDefined();

    const contributions = recordContributions(plugin!);
    contributions.artifactParsers![0]!.schemaVersion += 1;

    expect(
      paths({
        [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin!.manifest),
        [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify(contributions),
      }),
    ).toContain('contributions.artifactParsers[0].schemaVersion');
  });

  it('交互类型的版本必须与 manifest.interactionSchemas 对齐', () => {
    const plugin = [SALES_CAPABILITY].find(
      (item) => recordContributions(item).interactions!.length > 0,
    );
    expect(plugin, '需要一个注册了交互类型的能力包').toBeDefined();

    const contributions = recordContributions(plugin!);
    contributions.interactions![0]!.schemaVersion += 1;

    expect(
      paths({
        [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin!.manifest),
        [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify(contributions),
      }),
    ).toContain('contributions.interactions[0].schemaVersion');
  });

  it('岗位包数据本身不合法时按 RolePack 契约报错，而不是放过', () => {
    const pack = DISTRIBUTED_ROLE_PACKS[0]!;
    const { manifest, ...rest } = pack;
    const broken = structuredClone(rest) as Omit<RolePack, 'manifest'>;
    // 权重和不为 1 是岗位包最容易写错的地方，必须由外置路径同样拦住
    broken.competencyTemplates[0]!.defaultWeight += 0.5;

    const issues = validatePluginPackage({
      [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
      [PACKAGE_PACK_FILE]: JSON.stringify(broken),
    });

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.code === 'invalid-weight')).toBe(true);
  });

  it('parsePluginPackage 对坏包抛错而不是返回半成品', () => {
    expect(() => parsePluginPackage({ [PACKAGE_MANIFEST_FILE]: '{}' })).toThrow();
  });

  it('pack.json 缺字段时报缺哪个字段，而不是让校验器崩掉', () => {
    // validateRolePack 是为仓库内岗位包写的，靠 TypeScript 保证字段存在。喂它一份缺字段的
    // 外部 JSON 会抛 TypeError，于是安装路径变成「崩」而不是「拒装」
    const manifest = DISTRIBUTED_ROLE_PACKS[0]!.manifest;
    const issues = validatePluginPackage({
      [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
      [PACKAGE_PACK_FILE]: JSON.stringify({ competencyTemplates: [] }),
    });

    expect(issues.map((item) => item.path)).toContain('pack.rubrics');
    expect(issues.map((item) => item.path)).toContain('pack.promptFragments');
  });

  it('字段类型完全乱来时也只返回问题列表，不抛异常', () => {
    const manifest = DISTRIBUTED_ROLE_PACKS[0]!.manifest;
    const nonsense = Object.fromEntries(
      ['roleMatchers', 'competencyTemplates', 'interviewStages', 'interviewFormats', 'rubrics', 'taskTemplates', 'promptFragments', 'sourcePolicy'].map(
        (field) => [field, 'not the right type'],
      ),
    );

    expect(() =>
      validatePluginPackage({
        [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
        [PACKAGE_PACK_FILE]: JSON.stringify(nonsense),
      }),
    ).not.toThrow();
    expect(
      validatePluginPackage({
        [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest),
        [PACKAGE_PACK_FILE]: JSON.stringify(nonsense),
      }).length,
    ).toBeGreaterThan(0);
  });
});
