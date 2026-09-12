/**
 * 客户对话交互协议的内置场景素材。
 *
 * 场景是交互协议的运行时素材（宿主组织台词用），不是插件声明的一部分——
 * 声明（交互 schema）归岗位包，素材随协议走，core 因此只认识协议不认识插件。
 */
/** 场景模板：声明式数据，供宿主运行时组织客户台词；插件不含可执行逻辑。 */
/** 客户对话交互的 schema 版本；与岗位包 capabilities.ts 的声明一致。 */
export const CUSTOMER_CONVERSATION_SCHEMA_VERSION = 1;

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

