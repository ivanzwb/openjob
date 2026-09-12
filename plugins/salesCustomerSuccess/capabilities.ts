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

/**
 * 插入点 E：销售岗位内嵌的角色扮演能力。
 *
 * 交互声明归本包所有（随包分发与校验）；宿主运行时按 schema 渲染并生成
 * 客户台词——插件不含可执行逻辑，宿主也不认识「role-play」这个具体 id。
 */
export const capabilities: CapabilityDeclaration[] = [
  {
    id: 'role-play',
    interactions: [customerConversationInteraction],
    // 交互贡献没有逐项 permission 字段：台词生成走 llm，语音作答走麦克风
    permissions: ['llm:complete', 'microphone:read'],
  },
];
