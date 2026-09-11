import { EXAM_FORMS, TASK_KINDS } from '@core/enums';
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
import {
  formatIdForLegacyExamForm,
  LEGACY_ROLE_PACK_REF,
  SOFTWARE_ENGINEERING_FORMAT_IDS,
} from '@core/plugins/legacyRoleData';
import type {
  InterviewFormatDefinition,
  PromptFragmentSet,
  RolePack,
  RubricAnchors,
} from '@core/plugins/types';

/**
 * 岗位包与历史数据共用同一组 id：本包已经被 pin 进旧 Campaign 的 descriptor 与
 * quiz/design 投影，两处各写一份迟早会分叉，而分叉的表现是旧记录换了套量规。
 * 定义留在宿主的 legacyRoleData（基础包不带岗位包，宿主读旧数据时也得认得这些 id）。
 */
export const SOFTWARE_ENGINEERING_ROLE_PACK_ID = LEGACY_ROLE_PACK_REF.id;
/**
 * 岗位包自身的版本与旧数据无关了：id 仍沿用 LEGACY_ROLE_PACK_REF.id（旧 Campaign 的
 * descriptor 与题型投影 pin 着它），但包内容（依赖的能力合编包改名）换代时版本要跟着走，
 * 否则解析器会把新旧两份包当成同一份。
 */
export const SOFTWARE_ENGINEERING_ROLE_PACK_VERSION = '1.1.0';

/**
 * References into PROMPT_REGISTRY. Values are keys, never copied prompt bodies.
 * The complete map documents every prompt used by the current engineering flow;
 * promptFragments below selects the key appropriate to each role-pack slot.
 */
export const SOFTWARE_ENGINEERING_PROMPT_REFS = {
  diagnosis: {
    jd: 'diagnosis.jd',
    resume: 'diagnosis.resume',
    crossAnalyze: 'diagnosis.crossAnalyze',
    expand: 'diagnosis.expand',
    companyIntel: 'diagnosis.intel',
    extractQuestions: 'diagnosis.extractQuestions',
    matchQuestions: 'diagnosis.matchQuestions',
  },
  explanation: {
    generate: 'explain.generate',
    fallback: 'explain.fallback',
    elaborate: 'explain.elaborate',
    rewrite: 'explain.rewrite',
    followUp: 'followUp.node',
  },
  quiz: {
    question: 'quiz.question',
    score: 'quiz.score',
    answer: 'quiz.answer',
  },
  design: {
    case: 'design.case',
    score: 'design.score',
    answer: 'design.answer',
  },
} as const;

function anchors(
  one: string,
  two: string,
  three: string,
  four: string,
  five: string,
): RubricAnchors {
  return { 1: one, 2: two, 3: three, 4: four, 5: five };
}

const allFormatIds = EXAM_FORMS.map(formatIdForLegacyExamForm);

const promptFragments: PromptFragmentSet = {
  diagnosis: SOFTWARE_ENGINEERING_PROMPT_REFS.diagnosis.jd,
  explanation: SOFTWARE_ENGINEERING_PROMPT_REFS.explanation.generate,
  questionGeneration: {
    [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.question,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.coding]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.case,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.case,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.case,
  },
  scoring: {
    [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.score,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.coding]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.score,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.score,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.score,
  },
  answerCoaching: {
    [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.answer,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.coding]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.answer,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.answer,
    [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive]:
      SOFTWARE_ENGINEERING_PROMPT_REFS.design.answer,
  },
};

const interviewFormats: InterviewFormatDefinition[] = [
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
    label: '技术知识问答',
    protocol: 'knowledge',
    defaultDurationMinutes: 30,
    followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
    rubricId: 'se.technical-knowledge-rubric',
  },
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
    label: '编码与算法',
    protocol: 'coding',
    defaultDurationMinutes: 45,
    followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
    rubricId: 'se.coding-rubric',
  },
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
    label: '系统设计',
    protocol: 'case',
    defaultDurationMinutes: 45,
    followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
    rubricId: 'se.system-design-rubric',
  },
  {
    id: SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    label: '项目技术深挖',
    protocol: 'behavioral',
    defaultDurationMinutes: 40,
    followUpPolicy: { maxRounds: 4, strategy: 'adaptive' },
    rubricId: 'se.project-technical-deep-dive-rubric',
  },
];

export const softwareEngineeringRolePack: RolePack = {
  manifest: {
    id: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
    version: SOFTWARE_ENGINEERING_ROLE_PACK_VERSION,
    type: 'role-pack',
    displayName: '软件工程',
    description: '软件工程岗位的技术诊断、训练和模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [],
    dependencies: [{ id: CORE_CAPABILITIES_PACK_ID, version: '^1.0.0', optional: true }],
  },
  roleMatchers: [
    {
      titlePatterns: [
        '\\bsoftware\\s+(?:development\\s+)?engineer\\b',
        '\\bsoftware\\s+developer\\b',
        '\\b(?:backend|back-end|frontend|front-end|fullstack|full-stack)\\s+(?:developer|engineer)\\b',
        '\\b(?:mobile|ios|android|web|platform|infrastructure|devops|site reliability|sre)\\s+engineer\\b',
        '\\b(?:java|python|go|golang|javascript|typescript|c\\+\\+|rust)\\s+(?:developer|engineer)\\b',
        '(?:软件|开发|后端|前端|全栈|客户端|移动端|基础架构|平台|运维开发|测试开发|测试)工程师',
        '(?:程序员|软件开发|后端开发|前端开发|全栈开发)',
      ],
      responsibilitySignals: [
        'software development',
        'data structures',
        'algorithms',
        'distributed systems',
        'system design',
        '代码',
        '算法',
        '系统设计',
        '分布式',
      ],
      excludeSignals: [
        'product roadmap',
        'sales pipeline',
        'customer success',
        '产品路线图',
        '销售漏斗',
        '客户成功',
      ],
    },
  ],
  competencyTemplates: [
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
  ],
  interviewStages: [
    {
      id: 'se.technical-screen',
      label: '技术筛选',
      order: 0,
      formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge],
      defaultWeight: 0.2,
    },
    {
      id: 'se.coding-interview',
      label: '编码面试',
      order: 1,
      formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.coding],
      defaultWeight: 0.3,
    },
    {
      id: 'se.system-design-interview',
      label: '系统设计面试',
      order: 2,
      formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign],
      defaultWeight: 0.3,
    },
    {
      id: 'se.project-technical-interview',
      label: '项目技术面',
      order: 3,
      formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive],
      defaultWeight: 0.2,
    },
  ],
  interviewFormats,
  rubrics: [
    {
      id: 'se.technical-knowledge-rubric',
      dimensions: [
        {
          id: 'technical-accuracy',
          label: '技术准确性',
          weight: 0.5,
          critical: true,
          anchors: anchors(
            '核心结论错误或自相矛盾',
            '结论部分正确，但关键机制解释错误',
            '结论正确，能解释主要机制',
            '准确解释机制、边界和常见陷阱',
            '能从机制推导边界并比较实际取舍',
          ),
        },
        {
          id: 'depth',
          label: '原理深度',
          weight: 0.3,
          anchors: anchors(
            '停留在术语复述',
            '只能回答定义，无法承接追问',
            '能回答一层原理追问',
            '能连接实现细节与实际影响',
            '能跨层分析并指出版本或场景差异',
          ),
        },
        {
          id: 'tradeoffs',
          label: '工程取舍',
          weight: 0.2,
          anchors: anchors(
            '把方案描述为无条件最优',
            '知道存在取舍但无法说明',
            '能说出主要优缺点',
            '能结合约束选择方案',
            '能量化约束并说明决策边界',
          ),
        },
      ],
      passThreshold: 3,
      failConditions: ['技术准确性为 1 分'],
    },
    {
      id: 'se.coding-rubric',
      dimensions: [
        {
          id: 'correctness',
          label: '正确性',
          weight: 0.4,
          critical: true,
          anchors: anchors(
            '没有可执行解法',
            '只能通过少量基本样例',
            '主要逻辑正确，遗漏少量边界',
            '解法正确并覆盖关键边界',
            '解法正确、简洁且验证充分',
          ),
        },
        {
          id: 'complexity',
          label: '复杂度与方案选择',
          weight: 0.25,
          anchors: anchors(
            '无法分析复杂度',
            '复杂度判断明显错误',
            '能正确说明主要时间和空间复杂度',
            '能比较方案并选择合理复杂度',
            '能证明关键界限并识别实际性能因素',
          ),
        },
        {
          id: 'edge-cases-and-testing',
          label: '边界与测试',
          weight: 0.2,
          anchors: anchors(
            '不检查样例或边界',
            '只能覆盖题目给出的样例',
            '能识别常见空值和边界输入',
            '主动构造分类测试并修正缺陷',
            '用不变量和系统化测试验证实现',
          ),
        },
        {
          id: 'implementation-clarity',
          label: '实现表达',
          weight: 0.15,
          anchors: anchors(
            '思路和代码均难以理解',
            '代码可运行但结构混乱',
            '能边写边解释主要步骤',
            '命名清晰，主动说明关键决策',
            '表达简洁，能根据反馈快速调整实现',
          ),
        },
      ],
      passThreshold: 3,
      failConditions: ['正确性为 1 分'],
    },
    {
      id: 'se.system-design-rubric',
      dimensions: [
        {
          id: 'requirements-and-scale',
          label: '需求与规模澄清',
          weight: 0.2,
          anchors: anchors(
            '未澄清需求就给出方案',
            '只确认功能，忽略规模和质量目标',
            '覆盖主要功能、规模和质量目标',
            '能识别关键不确定性并建立假设',
            '能量化约束并持续用约束校验方案',
          ),
        },
        {
          id: 'architecture-and-data-flow',
          label: '架构与数据流',
          weight: 0.3,
          critical: true,
          anchors: anchors(
            '组件堆叠且数据流不成立',
            '有高层组件但职责或接口含混',
            '架构可行，关键路径清楚',
            '模块边界清晰并覆盖主要故障路径',
            '架构演进路径、控制面和数据面均清楚',
          ),
        },
        {
          id: 'scalability-and-reliability',
          label: '扩展性与可靠性',
          weight: 0.3,
          anchors: anchors(
            '未处理容量或故障',
            '只罗列缓存、队列等组件',
            '能处理主要瓶颈和单点故障',
            '覆盖降级、恢复、一致性和可观测性',
            '能量化容量并分析级联故障与恢复目标',
          ),
        },
        {
          id: 'design-tradeoffs',
          label: '设计取舍',
          weight: 0.2,
          anchors: anchors(
            '没有取舍说明',
            '只陈述方案优点',
            '能解释主要优缺点',
            '能根据业务约束选择并说明替代方案',
            '能量化成本、风险并给出演进触发条件',
          ),
        },
      ],
      passThreshold: 3,
      failConditions: ['架构与数据流为 1 分'],
    },
    {
      id: 'se.project-technical-deep-dive-rubric',
      dimensions: [
        {
          id: 'technical-ownership',
          label: '技术贡献边界',
          weight: 0.3,
          critical: true,
          anchors: anchors(
            '无法区分个人与团队工作',
            '能说负责内容但缺少具体行动',
            '个人范围、行动和产出清楚',
            '能说明主导决策及跨团队影响',
            '能完整还原责任边界和关键技术领导行为',
          ),
        },
        {
          id: 'evidence-and-results',
          label: '证据与结果',
          weight: 0.25,
          anchors: anchors(
            '关键经历与已提供材料冲突',
            '只有笼统结果，缺少验证方式',
            '结果可信且能说明验证方法',
            '有可追溯指标、基线和影响范围',
            '能解释指标因果、限制和长期结果',
          ),
        },
        {
          id: 'decision-reasoning',
          label: '决策与取舍',
          weight: 0.25,
          anchors: anchors(
            '无法解释为何采用该方案',
            '理由仅为惯例或上级要求',
            '能说明约束、候选方案和主要取舍',
            '能结合数据说明决策与调整过程',
            '能重建不确定性下的决策并分析反事实',
          ),
        },
        {
          id: 'technical-reflection',
          label: '技术复盘',
          weight: 0.2,
          anchors: anchors(
            '不能识别问题或改进点',
            '改进停留在泛泛表述',
            '能指出具体问题和下一步改进',
            '能说明教训如何改变后续工程实践',
            '能提炼可迁移原则并说明适用边界',
          ),
        },
      ],
      passThreshold: 3,
      failConditions: ['技术贡献边界为 1 分', '证据与结果为 1 分'],
    },
  ],
  taskTemplates: [
    {
      id: 'se.learn',
      label: '学习工程考点',
      taskKind: TASK_KINDS[0],
      defaultMinutes: 30,
      supportedFormats: allFormatIds,
    },
    {
      id: 'se.drill',
      label: '口头技术演练',
      taskKind: TASK_KINDS[1],
      defaultMinutes: 15,
      supportedFormats: allFormatIds,
    },
    {
      id: 'se.read-code',
      label: '结合源码理解实现',
      taskKind: TASK_KINDS[2],
      defaultMinutes: 25,
      supportedFormats: [
        SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
        SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
        SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
      ],
      capabilityId: CORE_CAPABILITIES_PACK_ID,
    },
    {
      id: 'se.review',
      label: '复习薄弱考点',
      taskKind: TASK_KINDS[3],
      defaultMinutes: 15,
      supportedFormats: allFormatIds,
    },
    {
      id: 'se.fallback-script',
      label: '准备技术兜底话术',
      taskKind: TASK_KINDS[4],
      defaultMinutes: 10,
      supportedFormats: allFormatIds,
    },
  ],
  promptFragments,
  sourcePolicy: {
    preferredDomains: [
      'github.com',
      'stackoverflow.com',
      'nowcoder.com',
      'juejin.cn',
      'zhihu.com',
      '1point3acres.com',
      'cnblogs.com',
      'csdn.net',
    ],
    credibilityOverrides: {
      'github.com': 5,
      'stackoverflow.com': 4,
      'nowcoder.com': 3,
      'juejin.cn': 3,
      'zhihu.com': 3,
      '1point3acres.com': 3,
      'cnblogs.com': 2,
      'csdn.net': 1,
    },
    freshnessDays: {
      companyIntel: 7,
      interviewReports: 3,
      domainKnowledge: 540,
    },
  },
};
