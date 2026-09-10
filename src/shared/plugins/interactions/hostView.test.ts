import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_CONVERSATION_INTERACTION,
  CUSTOMER_CONVERSATION_SCHEMA_VERSION,
  customerConversationInteraction,
} from '../builtin/rolePlay';
import type { ClientPlatform, HostRenderedInteraction } from '../types';
import { buildInteractionHostView, type InteractionHostViewInput } from './hostView';
import { INTERACTION_PROTOCOL_VERSION } from './schema';

function input(overrides: Partial<InteractionHostViewInput> = {}): InteractionHostViewInput {
  return {
    interaction: customerConversationInteraction,
    platform: 'desktop',
    capabilityEnabled: true,
    pluginInstalled: true,
    knownSchemaVersion: CUSTOMER_CONVERSATION_SCHEMA_VERSION,
    grantedPermissions: ['llm:complete', 'microphone:read'],
    ...overrides,
  };
}

/** 把交互改成两端同权，用于验证「除 availability 外两端无差异」。 */
function bothPlatforms(
  availability: 'full' | 'view-only' | 'unsupported',
): HostRenderedInteraction {
  return {
    ...customerConversationInteraction,
    availability: { desktop: availability, mobile: availability },
  };
}

describe('宿主渲染决策', () => {
  it('桌面端可渲染时给出完整字段与必填结果字段', () => {
    const view = buildInteractionHostView(input());

    expect(view.renderable).toBe(true);
    expect(view.mode).toBe('full');
    expect(view.reason).toBeNull();
    expect(view.type).toBe(CUSTOMER_CONVERSATION_INTERACTION);
    expect(view.fields.map((field) => field.id)).toEqual([
      'persona',
      'scenario',
      'transcript',
      'remaining-time',
      'reply',
      'intent',
    ]);
    expect(view.requiredResultFieldIds).toEqual(['reply']);
  });

  it('手机端只读时不渲染任何字段', () => {
    const view = buildInteractionHostView(input({ platform: 'mobile' }));

    expect(view.renderable).toBe(false);
    expect(view.mode).toBe('view-only');
    expect(view.reason).toBe('platform-view-only');
    // 认不出或不该跑的东西一律不画，不做半渲染
    expect(view.fields).toEqual([]);
    expect(view.requiredResultFieldIds).toEqual([]);
  });

  /**
   * `availability` 是包作者自己填的。外置能力把自己写成手机端 full，界面就会在手机上渲染
   * 出一个交完没有下一步的表单——工具实现全在桌面宿主里。
   */
  it('外置能力声明成手机端 full 也只读，桌面端不受影响', () => {
    const interaction = bothPlatforms('full');

    expect(
      buildInteractionHostView(input({ interaction, platform: 'mobile', externalPlugin: true })),
    ).toMatchObject({
      renderable: false,
      mode: 'view-only',
      reason: 'external-capability-desktop-only',
      fields: [],
    });
    expect(
      buildInteractionHostView(input({ interaction, platform: 'desktop', externalPlugin: true }))
        .renderable,
    ).toBe(true);
  });

  it('外置能力声明成 unsupported 时保留 unsupported，不被上限抬成只读', () => {
    expect(
      buildInteractionHostView(
        input({
          interaction: bothPlatforms('unsupported'),
          platform: 'mobile',
          externalPlugin: true,
        }),
      ).reason,
    ).toBe('platform-unsupported');
  });

  it('降级判断按严重程度排序，先命中的即为最终原因', () => {
    // 同时满足「未启用」「未安装」时，报未启用
    expect(
      buildInteractionHostView(input({ capabilityEnabled: false, pluginInstalled: false })).reason,
    ).toBe('capability-disabled');
    expect(buildInteractionHostView(input({ pluginInstalled: false })).reason).toBe(
      'plugin-not-installed',
    );
    expect(
      buildInteractionHostView(
        input({ interaction: bothPlatforms('unsupported') }),
      ).reason,
    ).toBe('platform-unsupported');
  });

  it('声明版本高于本机认识的版本时退回只读', () => {
    const view = buildInteractionHostView(
      input({
        interaction: { ...bothPlatforms('full'), schemaVersion: 5 },
        knownSchemaVersion: 1,
      }),
    );

    expect(view.renderable).toBe(false);
    expect(view.reason).toBe('interaction-schema-unknown');
    expect(view.detail).toContain('只保留同步与查看');
  });

  it('本机完全不认识该交互类型时退回只读', () => {
    expect(buildInteractionHostView(input({ knownSchemaVersion: null })).reason).toBe(
      'interaction-schema-unknown',
    );
  });

  it('schema 含本机不认识的字段类型时整体降级，不半渲染', () => {
    const view = buildInteractionHostView(
      input({
        interaction: {
          ...bothPlatforms('full'),
          inputSchema: {
            protocolVersion: INTERACTION_PROTOCOL_VERSION,
            fields: [
              { id: 'reply', kind: 'reply', label: '回应', maxChars: 10, voiceCapable: false },
              // 来自更新版本的字段类型
              { id: 'canvas', kind: 'whiteboard', label: '白板' },
            ] as never,
          },
        },
      }),
    );

    expect(view.renderable).toBe(false);
    expect(view.reason).toBe('interaction-schema-unknown');
    expect(view.fields).toEqual([]);
  });
});

describe('两端降级一致性', () => {
  /**
   * 一致性不是靠两套 UI 各自守规矩，而是结构上只有一处判断。
   * 因此在 availability 相同的前提下，两端结果必须逐字段相同（platform 字段除外）。
   */
  it.each(['full', 'view-only', 'unsupported'] as const)(
    'availability 为 %s 时两端结论除 platform 外完全相同',
    (availability) => {
      const interaction = bothPlatforms(availability);
      const [desktop, mobile] = (['desktop', 'mobile'] as ClientPlatform[]).map((platform) =>
        buildInteractionHostView(input({ interaction, platform })),
      );

      expect(desktop.platform).toBe('desktop');
      expect(mobile.platform).toBe('mobile');
      expect({ ...desktop, platform: null }).toEqual({ ...mobile, platform: null });
    },
  );

  it.each(['desktop', 'mobile'] as ClientPlatform[])(
    '%s 端对不认识的 schema 版本给出同一条降级理由',
    (platform) => {
      const view = buildInteractionHostView(
        input({
          interaction: { ...bothPlatforms('full'), schemaVersion: 9 },
          knownSchemaVersion: 1,
          platform,
        }),
      );

      expect(view.reason).toBe('interaction-schema-unknown');
      expect(view.detail).toBe('本机不认识该交互的 schema 版本，只保留同步与查看');
    },
  );
});

describe('麦克风权限', () => {
  it('已授权时语音可用', () => {
    const view = buildInteractionHostView(input());
    const reply = view.fields.find((field) => field.id === 'reply');

    expect(reply).toMatchObject({ kind: 'reply', voiceEnabled: true, voiceNotice: null });
  });

  /** 权限撤销只影响语音，交互本身照样能进行——这是「权限撤销不破坏 Campaign」的渲染侧一半。 */
  it('撤销麦克风后仍可渲染，只是改为文字作答', () => {
    const view = buildInteractionHostView(input({ grantedPermissions: ['llm:complete'] }));
    const reply = view.fields.find((field) => field.id === 'reply');

    expect(view.renderable).toBe(true);
    expect(view.mode).toBe('full');
    expect(view.reason).toBeNull();
    expect(reply).toMatchObject({ kind: 'reply', voiceEnabled: false });
    expect(reply?.kind === 'reply' ? reply.voiceNotice : null).toContain('文字作答');
  });
});
