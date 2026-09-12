import type { CompetencyTemplate } from '@core/plugins/types';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '@core/plugins/legacyRoleData';

export const competencyTemplates: CompetencyTemplate[] = [
  {
    id: 'se.computer-science-foundations',
    name: '计算机与工程基础',
    category: 'knowledge',
    description: '准确解释核心概念、运行机制、边界及工程取舍',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只能复述术语，关键结论存在明显错误' },
      { level: 3, behavior: '能准确解释常见机制并回答一层追问' },
      { level: 5, behavior: '能从底层机制推导边界，并结合约束比较方案' },
    ],
    evidenceKinds: ['skill', 'experience'],
    supportedFormats: [
      SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
      SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    ],
  },
  {
    id: 'se.coding-and-algorithms',
    name: '编码与算法',
    category: 'skill',
    description: '把问题转化为正确、清晰、可验证且复杂度合理的实现',
    defaultWeight: 0.25,
    levelIndicators: [
      { level: 1, behavior: '无法形成可执行思路或实现不能通过基本样例' },
      { level: 3, behavior: '能完成常见题型并说明主要复杂度与边界' },
      { level: 5, behavior: '能比较多种方案，快速验证并写出生产级实现' },
    ],
    evidenceKinds: ['skill', 'experience', 'achievement'],
    supportedFormats: [SOFTWARE_ENGINEERING_FORMAT_IDS.coding],
  },
  {
    id: 'se.system-design',
    name: '系统设计与架构',
    category: 'skill',
    description: '在规模、可靠性、一致性、延迟和成本约束下设计系统',
    defaultWeight: 0.25,
    levelIndicators: [
      { level: 1, behavior: '直接堆叠组件，不能说明需求、数据流或故障边界' },
      { level: 3, behavior: '能给出可行架构并解释主要扩展与可靠性方案' },
      { level: 5, behavior: '能量化关键约束、识别瓶颈并系统比较取舍' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: [
      SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
      SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    ],
  },
  {
    id: 'se.software-delivery',
    name: '工程交付质量',
    category: 'skill',
    description: '通过测试、可观测性、评审和发布控制持续交付可靠软件',
    defaultWeight: 0.15,
    levelIndicators: [
      { level: 1, behavior: '主要依赖手工验证，无法定位常见交付故障' },
      { level: 3, behavior: '能建立测试、监控和发布的基本质量闭环' },
      { level: 5, behavior: '能用数据治理跨团队质量、效率和运行风险' },
    ],
    evidenceKinds: ['experience', 'achievement'],
    supportedFormats: [
      SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
      SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
      SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    ],
  },
  {
    id: 'se.technical-project-depth',
    name: '项目技术深度',
    category: 'experience',
    description: '基于真实项目说明个人贡献、关键决策、技术取舍和复盘',
    defaultWeight: 0.15,
    levelIndicators: [
      { level: 1, behavior: '只能描述团队结果，个人行动和技术依据不清楚' },
      { level: 3, behavior: '能说明个人负责范围、决策依据和验证结果' },
      { level: 5, behavior: '能还原复杂约束、关键转折、量化结果和可迁移经验' },
    ],
    evidenceKinds: ['experience', 'achievement'],
    supportedFormats: [
      SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
      SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    ],
  },
];
