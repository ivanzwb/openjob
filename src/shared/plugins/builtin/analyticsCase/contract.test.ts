import { describe, expect, it } from 'vitest';

import { assertValidCapabilityPlugin } from '../../contracts';
import {
  buildClientCapabilityView,
  canParseArtifact,
  capabilityMode,
  listBuiltInPlugins,
} from '../../clientView';
import { BuiltInPluginRegistry } from '../../registry';
import { DeterministicRuntimeResolver } from '../../resolver';
import type {
  ArtifactParserDefinition,
  CampaignRuntimeDescriptor,
  CapabilityRegistry,
} from '../../types';
import { DISTRIBUTED_ROLE_PACKS } from '../../rolePacks';
import { BUILT_IN_CAPABILITY_PLUGINS } from '..';
import { PRODUCT_MANAGER_ROLE_PACK_ID, productManagerRolePack } from '../../rolePacks/productManager';
import {
  ANALYTICS_CASE_CAPABILITY_ID,
  ANALYTICS_CASE_CAPABILITY_VERSION,
  ANALYTICS_CASE_DELIVERABLES,
  ANALYTICS_CASE_SCENARIOS,
  TABULAR_DATASET_ARTIFACT_TYPE,
  TABULAR_DATASET_SCHEMA_VERSION,
  analyticsCaseCapabilityPlugin,
  findColumn,
  parseCsvArtifact,
} from '.';

function collectRegistered(): ArtifactParserDefinition[] {
  const parsers: ArtifactParserDefinition[] = [];
  const registry: CapabilityRegistry = {
    registerTool() {
      // 这个能力不该带可执行工具：解析由 Core 授权后代劳
      throw new Error('unexpected tool');
    },
    registerArtifactParser(parser) {
      parsers.push(parser);
    },
    registerInteractionType() {
      throw new Error('unexpected interaction');
    },
  };
  analyticsCaseCapabilityPlugin.register(registry);
  return parsers;
}

function resolveProductManager(): ReturnType<DeterministicRuntimeResolver['resolve']> {
  const registry = new BuiltInPluginRegistry();
  DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
  BUILT_IN_CAPABILITY_PLUGINS.forEach((plugin) => registry.registerCapability(plugin));
  return new DeterministicRuntimeResolver(registry).resolve({
    coreVersion: '1.0.0',
    schemaVersion: 23,
    rolePackId: PRODUCT_MANAGER_ROLE_PACK_ID,
    capabilityIds: [ANALYTICS_CASE_CAPABILITY_ID],
  });
}

function descriptorWithAnalytics(): CampaignRuntimeDescriptor {
  const resolved = resolveProductManager();
  if (!resolved.ok) throw new Error('产品岗解析本应成功');
  // resolver 产出的是与 Campaign 无关的快照，补上绑定字段才是描述符
  return { ...resolved.descriptor, campaignId: 'c-analytics', resolvedAt: 0 };
}

describe('analyticsCaseCapabilityPlugin 契约', () => {
  it('通过能力插件契约校验', () => {
    expect(() => assertValidCapabilityPlugin(analyticsCaseCapabilityPlugin)).not.toThrow();
    expect(analyticsCaseCapabilityPlugin.manifest.id).toBe(ANALYTICS_CASE_CAPABILITY_ID);
    expect(analyticsCaseCapabilityPlugin.manifest.version).toBe(ANALYTICS_CASE_CAPABILITY_VERSION);
    expect(analyticsCaseCapabilityPlugin.manifest.type).toBe('capability');
  });

  it('只申请读 artifact，拿不到模型、文件系统和网络', () => {
    // 一旦这里多出 llm:complete 或 filesystem:workspace，插件就有了绕过 Core 的入口
    expect(analyticsCaseCapabilityPlugin.manifest.permissions).toEqual(['artifact:read']);
  });

  it('声明的 artifact schema 与解析产出的版本一致', () => {
    expect(analyticsCaseCapabilityPlugin.manifest.artifactSchemas).toEqual({
      [TABULAR_DATASET_ARTIFACT_TYPE]: TABULAR_DATASET_SCHEMA_VERSION,
    });

    const parsed = parseCsvArtifact('a\n1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Manifest 里写的版本和真实产出对不上，客户端就会按能解析去解析一份读不懂的数据
    expect(parsed.dataset.schemaVersion).toBe(TABULAR_DATASET_SCHEMA_VERSION);
  });

  it('只注册 artifact 解析器，不注册题型与工具', () => {
    expect(collectRegistered()).toEqual([
      {
        artifactType: TABULAR_DATASET_ARTIFACT_TYPE,
        schemaVersion: TABULAR_DATASET_SCHEMA_VERSION,
        permission: 'artifact:read',
      },
    ]);
  });

  it('声明式数据能原样 JSON 往返，插件里没有可执行逻辑', () => {
    const roundTrip = JSON.parse(JSON.stringify(ANALYTICS_CASE_SCENARIOS));
    expect(roundTrip).toEqual(ANALYTICS_CASE_SCENARIOS);
  });

  it('进入内置插件清单，无需再单独注册一次', () => {
    expect(BUILT_IN_CAPABILITY_PLUGINS).toContain(analyticsCaseCapabilityPlugin);
    expect(listBuiltInPlugins().map((plugin) => plugin.id)).toContain(
      ANALYTICS_CASE_CAPABILITY_ID,
    );
  });
});

describe('内置场景可直接出题', () => {
  it.each(ANALYTICS_CASE_SCENARIOS)('$title 的样例数据能解析', (scenario) => {
    const parsed = parseCsvArtifact(scenario.sampleCsv);
    expect(parsed.ok, `解析失败：${parsed.ok ? '' : parsed.message}`).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dataset.rows.length).toBeGreaterThan(0);
    expect(parsed.dataset.truncated).toBe(false);
  });

  it.each(ANALYTICS_CASE_SCENARIOS)('$title 点名的列在数据里真的存在', (scenario) => {
    const parsed = parseCsvArtifact(scenario.sampleCsv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const name of scenario.focusColumns) {
      // 题面让人重点看一列、数据里却没有这列，是这类题最难查的出题错误
      expect(findColumn(parsed.dataset, name), `场景缺少列 ${name}`).not.toBeNull();
    }
  });

  it('五个交付部分与作答结构一一对应', () => {
    expect(ANALYTICS_CASE_DELIVERABLES.map((item) => item.id)).toEqual([
      'overview',
      'metrics',
      'hypotheses',
      'recommendations',
      'risks',
    ]);
  });
});

describe('产品岗可选启用', () => {
  it('产品岗把它作为可选依赖，缺席不影响岗位可用', () => {
    const dependency = productManagerRolePack.manifest.dependencies?.find(
      (item) => item.id === ANALYTICS_CASE_CAPABILITY_ID,
    );
    expect(dependency).toMatchObject({ optional: true });
  });

  it('启用后桌面可解析 artifact，手机只读', () => {
    const descriptor = descriptorWithAnalytics();
    const input = { descriptor, installed: listBuiltInPlugins() };
    const artifacts = [
      {
        capabilityId: ANALYTICS_CASE_CAPABILITY_ID,
        artifactType: TABULAR_DATASET_ARTIFACT_TYPE,
        schemaVersion: TABULAR_DATASET_SCHEMA_VERSION,
      },
    ];

    const desktop = buildClientCapabilityView({ ...input, platform: 'desktop', artifacts });
    const mobile = buildClientCapabilityView({ ...input, platform: 'mobile', artifacts });

    expect(capabilityMode(desktop, ANALYTICS_CASE_CAPABILITY_ID)).toBe('full');
    // 手机端没有文件选择与表格读入，只能看已同步的结果
    expect(capabilityMode(mobile, ANALYTICS_CASE_CAPABILITY_ID)).toBe('view-only');
    expect(canParseArtifact(desktop, artifacts[0])).toBe(true);
    expect(desktop.configSnapshotHash).toBe(mobile.configSnapshotHash);
  });

  it('比本机更高的 artifact 版本一律只读，不猜结构', () => {
    const descriptor = descriptorWithAnalytics();
    const view = buildClientCapabilityView({
      descriptor,
      platform: 'desktop',
      installed: listBuiltInPlugins(),
      artifacts: [
        {
          capabilityId: ANALYTICS_CASE_CAPABILITY_ID,
          artifactType: TABULAR_DATASET_ARTIFACT_TYPE,
          schemaVersion: TABULAR_DATASET_SCHEMA_VERSION + 1,
        },
      ],
    });

    expect(view.artifacts[0]).toMatchObject({
      parsable: false,
      reason: 'artifact-schema-unknown',
    });
  });
});
