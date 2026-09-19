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

/**
 * 能力包格式用例的素材：从 SE 包的内嵌声明里取一条来包。
 *
 * SE 的内嵌声明只有权限与 LLM 角色，外部能力包至少要有一项注册内容，所以这里补一个
 * 工作区工具贡献，顺带给「贡献权限必须与 manifest 对齐」那条用例备好素材。
 */
const SE_CAPABILITY = declarationPlugin('demo-source-repository', {
  ...softwareEngineeringRolePack.capabilities[0]!,
  tools: [
    {
      name: 'grep',
      description: 'Search workspace file contents.',
      permission: 'filesystem:workspace',
      inputSchemaVersion: 1,
    },
  ],
});
const PM_CAPABILITY = declarationPlugin(
  'demo-analytics-case',
  productManagerRolePack.capabilities[0]!,
);

/**
 * 宿主渲染交互正在退场：销售包（及其它内置岗位包）不再声明交互类型，改成由包自己的页面
 * 渲染（见 salesCustomerSuccess/capabilities.ts）。交互规则本身还留在 contract 里——
 * validateInteraction 仍在校验交互版本与 manifest.interactionSchemas 对齐——所以这里自带一份
 * 本地构造的交互声明来验它，不再借用岗位包的内嵌声明。
 */
const ROLE_PLAY_INTERACTION: HostRenderedInteraction = {
  type: 'customer-conversation',
  schemaVersion: 1,
  availability: { desktop: 'full', mobile: 'view-only' },
  inputSchema: {
    protocolVersion: 1,
    fields: [
      { id: 'brief', kind: 'note', label: '场景与本轮目标' },
      { id: 'reply', kind: 'reply', label: '你的回应', maxChars: 1200, voiceCapable: true },
    ],
  },
  resultSchema: {
    protocolVersion: 1,
    fields: [{ id: 'reply', valueType: 'text', required: true }],
  },
};

const INTERACTION_CAPABILITY = declarationPlugin('demo-role-play', {
  id: 'demo-role-play',
  interactions: [ROLE_PLAY_INTERACTION],
});

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
    // 这条声明的 manifest 里没有 microphone:read：把工具权限改成它之后
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
    const plugin = [INTERACTION_CAPABILITY].find(
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

describe('代码插件各端入口（v3，无向后兼容）', () => {
  const baseManifest = {
    id: 'demo-plugin',
    version: '1.0.0',
    type: 'plugin' as const,
    displayName: '演示',
    description: '代码插件格式用例',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [] as string[],
    api: '^1.0',
  };

  function pluginFiles(
    manifest: Record<string, unknown>,
    assets: Record<string, string>,
  ): PluginPackageFiles {
    return { [PACKAGE_MANIFEST_FILE]: JSON.stringify(manifest), ...assets };
  }

  it('main 只认 desktop/main.js：写成 main.js 或写错平台都判为无效', () => {
    expect(paths(pluginFiles({ ...baseManifest, main: 'main.js' }, { 'main.js': 'x' }))).toContain(
      'manifest.main',
    );
    expect(
      paths(pluginFiles({ ...baseManifest, main: 'mobile/main.js' }, { 'mobile/main.js': 'x' })),
    ).toContain('manifest.main');
  });

  it('mobile 只认 mobile/main.js', () => {
    expect(
      paths(pluginFiles({ ...baseManifest, mobile: 'desktop/main.js' }, { 'desktop/main.js': 'x' })),
    ).toContain('manifest.mobile');
  });

  it('声明了 mobile 却缺少 mobile/main.js → 无效', () => {
    const issues = paths(
      pluginFiles({ ...baseManifest, mobile: 'mobile/main.js' }, { 'mobile/ui/x.html': '<p>x</p>' }),
    );
    expect(issues).toContain('mobile/main.js');
  });

  it('声明了 main 却缺少 desktop/main.js → 无效', () => {
    const issues = paths(
      pluginFiles({ ...baseManifest, main: 'desktop/main.js' }, { 'desktop/ui/x.html': '<p>x</p>' }),
    );
    expect(issues).toContain('desktop/main.js');
  });

  it('ui 资产必须在对应平台目录下：顶层 main.js / ui/** 都不再是合法资产', () => {
    const issues = paths(
      pluginFiles(
        { ...baseManifest, main: 'desktop/main.js' },
        { 'desktop/main.js': 'x', 'main.js': 'y', 'ui/x.html': '<p>x</p>' },
      ),
    );
    expect(issues).toContain('main.js');
    expect(issues).toContain('ui/x.html');
  });

  it('两端入口齐全的包合法，解析后 codeAssets 带平台前缀', () => {
    const files = pluginFiles(
      { ...baseManifest, main: 'desktop/main.js', mobile: 'mobile/main.js' },
      {
        'desktop/main.js': 'exports.activate = () => undefined;',
        'desktop/ui/index.html': '<p>d</p>',
        'mobile/main.js': 'exports.activate = () => undefined;',
        'mobile/ui/index.html': '<p>m</p>',
      },
    );

    expect(validatePluginPackage(files)).toEqual([]);
    expect(Object.keys(parsePluginPackage(files).codeAssets!).sort()).toEqual([
      'desktop/main.js',
      'desktop/ui/index.html',
      'mobile/main.js',
      'mobile/ui/index.html',
    ]);
  });

  it('只提供一端也合法（缺的那端不出现页签，不是坏包）', () => {
    const files = pluginFiles(
      { ...baseManifest, main: 'desktop/main.js' },
      { 'desktop/main.js': 'exports.activate = () => undefined;' },
    );
    expect(validatePluginPackage(files)).toEqual([]);
  });
});

