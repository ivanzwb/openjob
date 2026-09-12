import { INTERACTION_PROTOCOL_VERSION } from '@core/plugins/interactions/schema';
import type {
  CapabilityDeclaration,
  HostRenderedInteraction,
} from '@core/plugins/types';

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
    ],
  },
];


/**
 * 插入点 E：销售岗位内嵌的角色扮演能力。
 *
 * 交互声明与场景素材都归本包：随包分发与校验，随 descriptor 供宿主运行时
 * 按 schema 渲染、按场景生成客户台词——插件不含可执行逻辑，宿主也不认识
 * 「role-play」这个具体 id。
 */
export const capabilities: CapabilityDeclaration[] = [
  {
    id: 'role-play',
    interactions: [customerConversationInteraction],
    // 交互贡献没有逐项 permission 字段：台词生成走 llm，语音作答走麦克风
    permissions: ['llm:complete', 'microphone:read'],
    scenarios: ROLE_PLAY_SCENARIOS as unknown as ReadonlyArray<Record<string, unknown>>,
  },
];
