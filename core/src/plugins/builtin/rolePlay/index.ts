/**
 * role-play 能力插件：客户对话模拟。
 *
 * 销售/客户成功岗位包把 `sales.customer-role-play` 题型的 capabilityId 指向本插件；
 * 插件缺席时岗位包降级为文字行为题（见 salesCustomerSuccess 的 golden 测试）。
 *
 * 边界：
 * - 插件只声明交互结构与场景数据，不注入任何组件，宿主按封闭字段协议渲染；
 * - 客户台词由宿主运行时调用模型生成，插件拿不到模型句柄，也拿不到 API Key；
 * - 语音是可选增强，麦克风权限缺失或被撤销时回落为文字，不影响会话继续。
 */
import { INTERACTION_PROTOCOL_VERSION } from '../../interactions/schema';
import type { CapabilityPlugin, HostRenderedInteraction } from '../../types';

export const ROLE_PLAY_CAPABILITY_ID = 'role-play';
export const ROLE_PLAY_CAPABILITY_VERSION = '1.0.0';

/** 客户对话交互类型；与 Manifest.interactionSchemas 的键一致。 */
export const CUSTOMER_CONVERSATION_INTERACTION = 'customer-conversation';
export const CUSTOMER_CONVERSATION_SCHEMA_VERSION = 1;

/** 单轮时长上限；超时由运行时判定，这里只是渲染倒计时的总时长。 */
export const CUSTOMER_CONVERSATION_TOTAL_SECONDS = 1800;

/**
 * 候选人为自己这一轮标注意图。
 *
 * 这是销售训练里的常规做法：先说清本轮想达成什么，再看客户的反应，
 * 评分侧也因此拿到结构化信号，而不是只有一段自由文本。
 */
export const ROLE_PLAY_INTENT_OPTIONS = [
  { value: 'discover', label: '探询需求' },
  { value: 'propose', label: '提出方案价值' },
  { value: 'handle-objection', label: '处理异议' },
  { value: 'advance', label: '推进下一步' },
] as const;

export const customerConversationInteraction: HostRenderedInteraction = {
  type: CUSTOMER_CONVERSATION_INTERACTION,
  schemaVersion: CUSTOMER_CONVERSATION_SCHEMA_VERSION,
  availability: {
    // 手机端尚无练习会话界面，只允许查看已同步的对话记录。
    desktop: 'full',
    mobile: 'view-only',
  },
  inputSchema: {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    fields: [
      { id: 'persona', kind: 'factList', label: '客户人设' },
      { id: 'scenario', kind: 'note', label: '场景与本轮目标' },
      { id: 'transcript', kind: 'transcript', label: '对话记录' },
      {
        id: 'remaining-time',
        kind: 'countdown',
        label: '剩余时间',
        totalSeconds: CUSTOMER_CONVERSATION_TOTAL_SECONDS,
      },
      {
        id: 'reply',
        kind: 'reply',
        label: '你的回应',
        maxChars: 1200,
        voiceCapable: true,
      },
      {
        id: 'intent',
        kind: 'choice',
        label: '本轮意图',
        options: [...ROLE_PLAY_INTENT_OPTIONS],
      },
    ],
  },
  resultSchema: {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    fields: [
      { id: 'reply', valueType: 'text', required: true },
      // 意图标注是训练辅助，不强制，缺失不阻塞本轮提交。
      { id: 'intent', valueType: 'choice', required: false },
    ],
  },
};

export interface RolePlayPersonaFact {
  label: string;
  value: string;
}

/**
 * 场景模板。
 *
 * 声明式数据，供宿主运行时组织客户台词；插件不含可执行逻辑。
 */
export interface RolePlayScenario {
  id: string;
  title: string;
  /** 渲染到 factList 字段的客户人设。 */
  persona: RolePlayPersonaFact[];
  /** 渲染到 note 字段的场景与目标。 */
  brief: string;
  /** 客户的开场白，保证第一轮无需调用模型也能开始。 */
  opening: string;
  /** 客户可能抛出的异议；运行时按对话进展挑选，避免每轮都自由发挥。 */
  objections: string[];
}

export const ROLE_PLAY_SCENARIOS: readonly RolePlayScenario[] = [
  {
    id: 'renewal-at-risk',
    title: '续约风险客户',
    persona: [
      { label: '角色', value: '中型制造企业的 IT 负责人' },
      { label: '合作现状', value: '已使用两年，下季度续约待定' },
      { label: '当前情绪', value: '对上季度的故障处理不满' },
      { label: '关心的事', value: '稳定性、内部问责、预算合理性' },
    ],
    brief: '客户在续约前提出降价并质疑服务质量。你需要先弄清真实顾虑，再谈价值与下一步。',
    opening: '你们上个季度那次故障，我在管理层会上很难解释。这次续约，价格得给我一个说法。',
    objections: [
      '你说的改进，怎么保证不是又一次口头承诺？',
      '同类产品报价比你们低两成，我为什么不换？',
      '我内部已经有人主张自研了。',
    ],
  },
  {
    id: 'new-logo-discovery',
    title: '新客首次需求沟通',
    persona: [
      { label: '角色', value: '快消公司的电商运营总监' },
      { label: '合作现状', value: '首次接触，正在比较三家供应商' },
      { label: '当前情绪', value: '时间紧、防备心强' },
      { label: '关心的事', value: '上线周期、和现有系统的衔接、可量化收益' },
    ],
    brief: '客户只给了 30 分钟。你需要在有限时间里问出真实场景与决策路径，而不是急着讲产品。',
    opening: '我们时间不多，你先直接说你们和另外两家比有什么不一样吧。',
    objections: [
      '这些功能听起来都差不多，能不能说点别的？',
      '我们现在的系统改造成本谁承担？',
      '这个事今年不一定有预算。',
    ],
  },
];

export const rolePlayCapabilityPlugin: CapabilityPlugin = {
  manifest: {
    id: ROLE_PLAY_CAPABILITY_ID,
    version: ROLE_PLAY_CAPABILITY_VERSION,
    type: 'capability',
    displayName: 'Role Play',
    description: '客户对话模拟：宿主渲染的角色扮演交互，支持语音或文字作答。',
    compatibility: {
      core: '^1.0.0',
      schema: 23,
    },
    // llm:complete 用于生成客户台词；microphone:read 只为语音作答，可被撤销。
    permissions: ['llm:complete', 'microphone:read'],
    runtime: {
      desktop: 'full',
      mobile: 'view-only',
    },
    interactionSchemas: {
      [CUSTOMER_CONVERSATION_INTERACTION]: CUSTOMER_CONVERSATION_SCHEMA_VERSION,
    },
  },
  register(registry) {
    registry.registerInteractionType(customerConversationInteraction);
  },
};
