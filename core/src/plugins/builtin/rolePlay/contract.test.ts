import { describe, expect, it } from 'vitest';

import { assertValidCapabilityPlugin } from '../../contracts';
import {
  INTERACTION_FIELD_KINDS,
  validateInteractionResultSchema,
  validateInteractionSchema,
} from '../../interactions/schema';
import { BuiltInPluginRegistry } from '../../registry';
import { DeterministicRuntimeResolver } from '../../resolver';
import type { CapabilityRegistry, HostRenderedInteraction } from '../../types';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { CORE_CAPABILITIES_PACK_ID, coreCapabilitiesSuite } from '../../capabilitySuite';
import {
  CUSTOMER_CONVERSATION_INTERACTION,
  CUSTOMER_CONVERSATION_SCHEMA_VERSION,
  ROLE_PLAY_CAPABILITY_ID,
  ROLE_PLAY_SCENARIOS,
  customerConversationInteraction,
  rolePlayCapabilityPlugin,
} from '.';
import { SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID } from '@plugins/salesCustomerSuccess';

function collectRegistered(): HostRenderedInteraction[] {
  const interactions: HostRenderedInteraction[] = [];
  const registry: CapabilityRegistry = {
    registerTool() {
      throw new Error('unexpected tool');
    },
    registerArtifactParser() {
      throw new Error('unexpected parser');
    },
    registerInteractionType(interaction) {
      interactions.push(interaction);
    },
  };
  rolePlayCapabilityPlugin.register(registry);
  return interactions;
}

describe('rolePlayCapabilityPlugin 契约', () => {
  it('通过能力插件契约校验', () => {
    expect(() => assertValidCapabilityPlugin(rolePlayCapabilityPlugin)).not.toThrow();
    expect(rolePlayCapabilityPlugin.manifest.id).toBe(ROLE_PLAY_CAPABILITY_ID);
    expect(rolePlayCapabilityPlugin.manifest.type).toBe('capability');
  });

  it('只注册交互类型，不注册工具或 artifact parser', () => {
    const registered = collectRegistered();
    expect(registered).toHaveLength(1);
    expect(registered[0].type).toBe(CUSTOMER_CONVERSATION_INTERACTION);
  });

  it('Manifest 声明的交互版本与注册项一致', () => {
    expect(rolePlayCapabilityPlugin.manifest.interactionSchemas).toEqual({
      [CUSTOMER_CONVERSATION_INTERACTION]: CUSTOMER_CONVERSATION_SCHEMA_VERSION,
    });
  });

  /**
   * 「插件不注入任意 React 组件」的直接验法：整份声明必须能无损 JSON 往返。
   * 函数、类、组件、闭包都活不过 JSON.stringify，所以这条通过就意味着
   * 插件交给宿主的确实只是数据。
   */
  it('交互声明是纯数据，JSON 往返无损', () => {
    const roundTripped = JSON.parse(JSON.stringify(customerConversationInteraction));
    expect(roundTripped).toEqual(customerConversationInteraction);

    const walk = (value: unknown, path: string): void => {
      expect(typeof value, `${path} 不应是函数`).not.toBe('function');
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
      }
    };
    walk(customerConversationInteraction, 'interaction');
  });

  it('只使用 Core 拥有的封闭字段类型', () => {
    const kinds = customerConversationInteraction.inputSchema.fields.map((field) => field.kind);
    for (const kind of kinds) {
      expect(INTERACTION_FIELD_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('输入与结果 schema 双向合法', () => {
    expect(validateInteractionSchema(customerConversationInteraction.inputSchema)).toEqual([]);
    expect(
      validateInteractionResultSchema(
        customerConversationInteraction.resultSchema,
        customerConversationInteraction.inputSchema,
      ),
    ).toEqual([]);
  });

  it('语音是可选增强，回答字段本身仍是文字输入', () => {
    const reply = customerConversationInteraction.inputSchema.fields.find(
      (field) => field.id === 'reply',
    );
    expect(reply).toMatchObject({ kind: 'reply', voiceCapable: true });
    // 结果只回收文本，因此没有麦克风也能提交
    expect(customerConversationInteraction.resultSchema.fields).toEqual([
      { id: 'reply', valueType: 'text', required: true },
      { id: 'intent', valueType: 'choice', required: false },
    ]);
  });

  it('场景数据自带开场白，首轮不依赖模型', () => {
    expect(ROLE_PLAY_SCENARIOS.length).toBeGreaterThan(0);
    for (const scenario of ROLE_PLAY_SCENARIOS) {
      expect(scenario.opening.trim().length).toBeGreaterThan(0);
      expect(scenario.persona.length).toBeGreaterThan(0);
      expect(scenario.objections.length).toBeGreaterThan(0);
    }
    expect(new Set(ROLE_PLAY_SCENARIOS.map((item) => item.id)).size).toBe(
      ROLE_PLAY_SCENARIOS.length,
    );
  });
});

describe('注册期校验', () => {
  it('Manifest 未声明该交互版本时拒绝注册', () => {
    const registry = new BuiltInPluginRegistry();
    registry.registerCapability({
      ...rolePlayCapabilityPlugin,
      manifest: { ...rolePlayCapabilityPlugin.manifest, interactionSchemas: {} },
    });
    DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));

    const resolved = new DeterministicRuntimeResolver(registry).resolve({
      coreVersion: '1.0.0',
      schemaVersion: 23,
      rolePackId: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
      capabilityIds: [CORE_CAPABILITIES_PACK_ID],
    });

    expect(resolved.ok).toBe(false);
  });

  it('内置清单里的 role-play 能正常解析进 descriptor', () => {
    const registry = new BuiltInPluginRegistry();
    DISTRIBUTED_ROLE_PACKS.forEach((pack) => registry.register(pack));
    registry.registerCapability(coreCapabilitiesSuite);

    const resolved = new DeterministicRuntimeResolver(registry).resolve({
      coreVersion: '1.0.0',
      schemaVersion: 23,
      rolePackId: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
      capabilityIds: [CORE_CAPABILITIES_PACK_ID],
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const ref = resolved.descriptor.capabilities.find(
      (item) => item.id === CORE_CAPABILITIES_PACK_ID,
    );
    expect(ref?.enabled).toBe(true);
  });
});
