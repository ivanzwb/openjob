/**
 * 首个非工程岗位包。
 *
 * 它同时是插件化的验收样本：产品岗位与工程岗位共用 Core 的组合器、练习引擎和
 * 排程器，差异必须全部落在这份声明里。所以这里刻意不复用 Core 现有的工程
 * Prompt——`diagnosis.jd` 把 examForms 写死成 concept/coding/design/scenario，
 * `design.case` 与 `quiz.*` 也都按工程题型描述任务，产品岗位引用它们等于把编码和
 * 容量估算的口吻带进产品案例。岗位包自带片段是组合器给出的扩展点
 * （见 src/shared/prompts/composer.ts 的 fragmentRef）：片段只能追加，一级标题、
 * 事实来源规则和输出骨架仍归 Core。
 *
 * 案例题一律用纯文字描述数据，不依赖 `analytics-case`：该能力只是可选依赖，
 * 没装时解析结果里它是 disabled，产品案例仍然要能完整出题、作答和评分。
 */

import type { TaskKind } from '@shared/enums';
import type {
  CompetencyTemplate,
  InterviewFormatDefinition,
  InterviewStageTemplate,
  PromptFragmentSet,
  RolePack,
  RubricAnchors,
  RubricDefinition,
  TaskTemplate,
} from '@shared/plugins/types';

export const PRODUCT_MANAGER_ROLE_PACK_ID = 'product-manager';
export const PRODUCT_MANAGER_ROLE_PACK_VERSION = '1.0.0';

/** 可选能力：装了能加强，没装不影响任何一种题型可用。 */
export const PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS = {
  analyticsCase: 'analytics-case',
  portfolioReview: 'portfolio-review',
} as const;

export const PRODUCT_MANAGER_FORMAT_IDS = {
  productCase: 'pm.product-case',
  behavioral: 'pm.behavioral',
  presentation: 'pm.product-presentation',
} as const;

export const PRODUCT_MANAGER_COMPETENCY_IDS = {
  problemFraming: 'pm.problem-framing',
  userInsight: 'pm.user-insight',
  metrics: 'pm.metrics',
  prioritization: 'pm.prioritization',
  productDecision: 'pm.product-decision',
} as const;

export const PRODUCT_MANAGER_RUBRIC_IDS = {
  productCase: 'pm.product-case-rubric',
  behavioral: 'pm.behavioral-rubric',
  presentation: 'pm.product-presentation-rubric',
} as const;

const TASK_KIND = {
  learn: 'learn',
  drill: 'drill',
  review: 'review',
  fallbackScript: 'fallbackScript',
} as const satisfies Record<string, TaskKind>;

function anchors(
  one: string,
  two: string,
  three: string,
  four: string,
  five: string,
): RubricAnchors {
  return { 1: one, 2: two, 3: three, 4: four, 5: five };
}

const allFormatIds = Object.values(PRODUCT_MANAGER_FORMAT_IDS);

/**
 * 岗位包自带的 Prompt 片段。
 *
 * 每段只描述「产品岗位这一步该怎么问、怎么看」，不重写角色、输出格式和事实来源
 * 规则：那三样由 Core 独占，组合器会在片段之前注入。
 */
const promptFragments: PromptFragmentSet = {
  diagnosis: [
    '## 产品岗位诊断侧重',
    '- 按产品工作流拆解 JD：机会判断、用户洞察、指标设计、优先级取舍、上线与迭代。',
    '- 技术相关要求只按「产品经理需要理解到什么程度」收敛成协作与可行性判断，不要展开成实现方案、容量估算或代码层面的考点。',
    '- 每条职责都要落到可被案例题或行为题考到的能力上；落不下去的先记为未覆盖，不要凑一个相近的能力。',
  ].join('\n'),
  explanation: [
    '## 产品方法讲解侧重',
    '- 先讲这个方法解决什么判断问题，再讲步骤，最后给一个可套用的产出物样例。',
    '- 用一个具体的业务场景贯穿讲解，避免只停在框架名词。',
    '- 明确适用边界：什么情况下这个方法会给出错误结论。',
  ].join('\n'),
  questionGeneration: {
    [PRODUCT_MANAGER_FORMAT_IDS.productCase]: [
      '## 产品案例出题',
      '- 题干给出业务背景、目标人群和一条明确约束（时间、资源或数据可得性），并留出需要候选人自己澄清的空白。',
      '- 数据一律用文字和少量可口述的数字给出，候选人无需打开表格或运行分析工具即可完整作答。',
      '- 分层推进：先问问题定义与成功指标，再问方案与优先级，最后问上线后如何验证；一次只问一层。',
      // 用正面表述划定范围，而不是罗列「不要问什么」：把工程题型写进片段等于先
      // 让模型想一遍，反倒容易漂过去，也让污染扫描分不清「考」和「不考」
      '- 只考产品判断：候选人给出方向、取舍和衡量方式即可，不需要落到实现层面。',
    ].join('\n'),
    [PRODUCT_MANAGER_FORMAT_IDS.behavioral]: [
      '## 产品行为面出题',
      '- 围绕候选人真实做过的产品决策提问：当时的判断依据、被放弃的选项、推动过程和结果。',
      '- 追问要往具体处走：数据从哪来、谁不同意、最后怎么定的、事后回看哪里判断偏了。',
      '- 一次只追一个点，不要把多个问题合成一句。',
    ].join('\n'),
    [PRODUCT_MANAGER_FORMAT_IDS.presentation]: [
      '## 产品陈述出题',
      '- 指定听众（管理层、研发团队或客户）、时长和一个需要对方当场做出的决定。',
      '- 要求候选人口述陈述结构与关键结论，不要求提交幻灯片文件。',
      '- 预留质疑环节：给出一到两个听众最可能提出的反对意见。',
    ].join('\n'),
  },
  scoring: {
    [PRODUCT_MANAGER_FORMAT_IDS.productCase]: [
      '## 产品案例评分侧重',
      '- 看判断链条是否成立：问题定义、洞察、方案、指标之间要能互相支撑，任一环断了都不算完整作答。',
      '- 方案是否新颖不加分，能否说清取舍代价和放弃项才加分。',
      '- 指标要看是否可测且与目标一致，用了行业黑话但说不出口径的不给高分。',
      '- 不要因为候选人没谈技术实现或性能而扣分。',
    ].join('\n'),
    [PRODUCT_MANAGER_FORMAT_IDS.behavioral]: [
      '## 产品行为面评分侧重',
      '- 先分清个人贡献与团队结果：说不清自己做了什么的，个人贡献维度不能给到 3 分以上。',
      '- 看在意见不一致时是怎么推动决策的，以及事后如何验证当初的判断。',
      '- 结果要有可追溯的口径，只有「效果很好」这类表述不作为证据。',
    ].join('\n'),
    [PRODUCT_MANAGER_FORMAT_IDS.presentation]: [
      '## 产品陈述评分侧重',
      '- 看结论是否先行、是否围绕听众要做的那个决定组织内容。',
      '- 看论据与结论的对应关系，以及面对质疑时是否会区分「口径问题」和「判断问题」。',
      '- 表达流畅但没有推进决策的，不给高分。',
    ].join('\n'),
  },
  answerCoaching: {
    [PRODUCT_MANAGER_FORMAT_IDS.productCase]: [
      '## 产品案例作答话术',
      '- 按「问题定义 → 目标人群 → 成功指标 → 方案与优先级 → 验证方式」组织，每段一句话说清结论再展开。',
      '- 需要举例时只用候选人证据里已有的经历，缺少可用经历就改成「如果由我来做」的假想推演。',
      '- 主动交代放弃了哪些方向和为什么，这比多列一个方案更能拿分。',
    ].join('\n'),
    [PRODUCT_MANAGER_FORMAT_IDS.behavioral]: [
      '## 产品行为面作答话术',
      '- 用候选人自己的经历还原场景、个人动作、决策依据和结果，主语始终是「我」。',
      '- 结果给出当时真实的口径与量级，没有数字就说清是怎么判断有效的，不要补一个更漂亮的指标。',
      '- 结尾补一句可迁移的判断原则，并说明它适用的边界。',
    ].join('\n'),
    [PRODUCT_MANAGER_FORMAT_IDS.presentation]: [
      '## 产品陈述话术',
      '- 开场三十秒内给出请听众决定的事项和你的建议。',
      '- 中段按「现状 → 关键判断 → 建议方案 → 风险与回退」推进，每部分只留最强的一条论据。',
      '- 为最可能的反对意见准备一句直接回应，不绕开分歧。',
    ].join('\n'),
  },
  debrief: [
    '## 产品面后复盘侧重',
    '- 先按原文记录真实被问到的题目，再判断它落在哪个产品能力上。',
    '- 区分「没想到这个角度」和「想到了但没说清」：两者对应的改进动作不同。',
    '- 归纳这家公司关心的判断口径，供后续案例练习复用。',
  ].join('\n'),
};

const competencyTemplates: CompetencyTemplate[] = [
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.problemFraming,
    name: '问题定义与机会判断',
    category: 'skill',
    description: '把模糊诉求收敛成可判断的目标、范围和值得做的理由',
    defaultWeight: 0.22,
    levelIndicators: [
      { level: 1, behavior: '直接跳到方案，说不清要解决谁的什么问题' },
      { level: 3, behavior: '能界定目标人群、范围和判断成败的依据' },
      { level: 5, behavior: '能估算机会大小，并说明主动放弃了哪些方向及理由' },
    ],
    evidenceKinds: ['experience', 'achievement'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.presentation,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.userInsight,
    name: '用户洞察与调研',
    category: 'knowledge',
    description: '通过访谈、行为数据和竞品分析得到可行动的用户结论',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只凭个人直觉替用户做判断' },
      { level: 3, behavior: '能设计调研并归纳出可行动的结论' },
      { level: 5, behavior: '能交叉验证定性与定量结论，并预判样本与提问方式带来的偏差' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.metrics,
    name: '指标设计与验证',
    category: 'skill',
    description: '定义口径清晰的成功指标，并用实验或观测验证产品判断',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只会引用通用指标，说不出口径和适用场景' },
      { level: 3, behavior: '能为目标选出主指标与护栏指标，并说明口径' },
      { level: 5, behavior: '能设计实验、识别指标被操纵的路径并解释因果限制' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.presentation,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.prioritization,
    name: '优先级与资源取舍',
    category: 'skill',
    description: '在资源、时间和依赖约束下决定做什么、不做什么和先后顺序',
    defaultWeight: 0.18,
    levelIndicators: [
      { level: 1, behavior: '把所有需求都列为重要，排不出先后' },
      { level: 3, behavior: '能用一致的标准排出顺序并说明依据' },
      { level: 5, behavior: '能量化收益与代价，说明依赖关系和顺序调整的触发条件' },
    ],
    evidenceKinds: ['experience', 'achievement', 'behavior'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.productCase,
      PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    ],
  },
  {
    id: PRODUCT_MANAGER_COMPETENCY_IDS.productDecision,
    name: '产品决策与跨职能推动',
    category: 'behavior',
    description: '在信息不足和意见不一致时做出决策，并推动研发、设计与业务落地',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只能转述他人意见，推不动一次明确决策' },
      { level: 3, behavior: '能说明分歧点并促成一次可执行的决策' },
      { level: 5, behavior: '能还原高压场景下的决策依据、推动路径和事后校正' },
    ],
    evidenceKinds: ['behavior', 'experience', 'achievement'],
    supportedFormats: [
      PRODUCT_MANAGER_FORMAT_IDS.behavioral,
      PRODUCT_MANAGER_FORMAT_IDS.presentation,
    ],
  },
];

const interviewStages: InterviewStageTemplate[] = [
  {
    id: 'pm.product-screen',
    label: '产品初筛',
    order: 0,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.behavioral],
    defaultWeight: 0.2,
  },
  {
    id: 'pm.product-case-interview',
    label: '产品案例面',
    order: 1,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.productCase],
    defaultWeight: 0.4,
  },
  {
    id: 'pm.cross-functional-interview',
    label: '跨职能协作面',
    order: 2,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.behavioral],
    defaultWeight: 0.2,
  },
  {
    id: 'pm.final-presentation',
    label: '终面产品陈述',
    order: 3,
    formatIds: [PRODUCT_MANAGER_FORMAT_IDS.presentation],
    defaultWeight: 0.2,
  },
];

const interviewFormats: InterviewFormatDefinition[] = [
  {
    id: PRODUCT_MANAGER_FORMAT_IDS.productCase,
    label: '产品案例',
    protocol: 'case',
    defaultDurationMinutes: 45,
    followUpPolicy: { maxRounds: 3, strategy: 'adaptive' },
    rubricId: PRODUCT_MANAGER_RUBRIC_IDS.productCase,
    // 刻意不绑 capabilityId：analytics-case 只是加强项，纯文本案例必须独立成立
  },
  {
    id: PRODUCT_MANAGER_FORMAT_IDS.behavioral,
    label: '产品行为面',
    protocol: 'behavioral',
    defaultDurationMinutes: 35,
    followUpPolicy: { maxRounds: 4, strategy: 'adaptive' },
    rubricId: PRODUCT_MANAGER_RUBRIC_IDS.behavioral,
  },
  {
    id: PRODUCT_MANAGER_FORMAT_IDS.presentation,
    label: '产品陈述',
    protocol: 'presentation',
    defaultDurationMinutes: 30,
    followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
    rubricId: PRODUCT_MANAGER_RUBRIC_IDS.presentation,
  },
];

/**
 * 维度刻意与工程设计量规不重叠。
 *
 * 工程设计看的是架构、数据流、扩展性与可靠性；产品案例看的是问题定义、洞察、
 * 取舍和指标验证。两套维度同名会让跨岗位的历史评分被放在一起比较，而它们衡量
 * 的根本不是同一件事。
 */
const rubrics: RubricDefinition[] = [
  {
    id: PRODUCT_MANAGER_RUBRIC_IDS.productCase,
    dimensions: [
      {
        id: 'problem-definition',
        label: '问题定义与目标',
        weight: 0.3,
        critical: true,
        anchors: anchors(
          '没有界定问题就开始给方案',
          '只复述题面，目标人群和范围含混',
          '目标人群、范围和判断依据清楚',
          '能识别关键不确定性并建立明确假设',
          '能估算机会大小并说明放弃项及理由',
        ),
      },
      {
        id: 'user-and-market-insight',
        label: '用户与市场洞察',
        weight: 0.2,
        anchors: anchors(
          '用个人偏好代替用户诉求',
          '有洞察但与题干场景无关',
          '能给出与场景相关的用户结论',
          '能说明结论从哪类证据推出',
          '能交叉验证多来源并指出结论的偏差风险',
        ),
      },
      {
        id: 'solution-and-prioritization',
        label: '方案与优先级',
        weight: 0.25,
        anchors: anchors(
          '只有一个方案且没有理由',
          '罗列多个方案但不比较',
          '能比较主要方案的收益与代价',
          '能按一致标准排序并说明依赖关系',
          '能量化取舍并给出顺序调整的触发条件',
        ),
      },
      {
        id: 'success-metrics',
        label: '成功指标与验证',
        weight: 0.25,
        anchors: anchors(
          '没有提出任何衡量方式',
          '只给通用指标，说不出口径',
          '主指标与目标一致且口径清楚',
          '能配套护栏指标并说明验证方式',
          '能设计实验、预判指标失真并解释因果限制',
        ),
      },
    ],
    passThreshold: 3,
    failConditions: ['问题定义与目标为 1 分'],
  },
  {
    id: PRODUCT_MANAGER_RUBRIC_IDS.behavioral,
    dimensions: [
      {
        id: 'ownership-and-influence',
        label: '个人贡献与推动',
        weight: 0.35,
        critical: true,
        anchors: anchors(
          '分不清个人与团队做了什么',
          '能说职责但缺少具体动作',
          '个人范围、动作和产出清楚',
          '能说明主导的决策及其影响范围',
          '能还原意见不一致时的推动路径和代价',
        ),
      },
      {
        id: 'stakeholder-communication',
        label: '跨职能沟通',
        weight: 0.25,
        anchors: anchors(
          '只从自己视角叙述',
          '能说出他人立场但不影响自己判断',
          '能说明分歧点和各方关注',
          '能针对不同对象调整表达并达成一致',
          '能重建对齐过程，并说明留下了什么机制',
        ),
      },
      {
        id: 'product-judgment',
        label: '产品判断依据',
        weight: 0.2,
        anchors: anchors(
          '说不出当时为什么这么定',
          '理由仅为惯例或上级要求',
          '能说明约束、候选项和主要取舍',
          '能结合数据与用户证据说明决策',
          '能还原信息不足下的判断并分析反事实',
        ),
      },
      {
        id: 'outcome-reflection',
        label: '结果与复盘',
        weight: 0.2,
        anchors: anchors(
          '关键经历与已提供材料不一致',
          '只有笼统结果，说不清怎么验证',
          '结果可信且能说明验证方式',
          '能指出判断偏差和后续改进',
          '能提炼可迁移原则并说明适用边界',
        ),
      },
    ],
    passThreshold: 3,
    failConditions: ['个人贡献与推动为 1 分', '结果与复盘为 1 分'],
  },
  {
    id: PRODUCT_MANAGER_RUBRIC_IDS.presentation,
    dimensions: [
      {
        id: 'narrative-structure',
        label: '结构与结论先行',
        weight: 0.3,
        critical: true,
        anchors: anchors(
          '没有结论，听完不知道要决定什么',
          '结论埋在最后，铺垫过长',
          '开场给出结论，主线清楚',
          '每一段都在支撑要请听众做的决定',
          '结构紧凑，能按时间与听众反应临场调整',
        ),
      },
      {
        id: 'audience-adaptation',
        label: '听众适配',
        weight: 0.25,
        anchors: anchors(
          '不区分听众，一套说法讲到底',
          '知道听众不同但表达没有变化',
          '按听众关注点选择内容与措辞',
          '能预判听众顾虑并提前回应',
          '能同时照顾多方关注并推动当场决策',
        ),
      },
      {
        id: 'evidence-and-visuals',
        label: '论据与呈现',
        weight: 0.25,
        anchors: anchors(
          '论据与结论对不上',
          '堆砌数据但不解释含义',
          '关键结论都有对应论据',
          '论据精简有力，口径清楚',
          '能用一条主线串起证据并主动交代不确定性',
        ),
      },
      {
        id: 'qa-handling',
        label: '质疑应对',
        weight: 0.2,
        anchors: anchors(
          '回避质疑或答非所问',
          '被追问后放弃原判断',
          '能正面回应主要质疑',
          '能区分口径问题与判断问题分别回应',
          '能当场吸收有效反对意见并给出修正后的建议',
        ),
      },
    ],
    passThreshold: 3,
    failConditions: ['结构与结论先行为 1 分'],
  },
];

const taskTemplates: TaskTemplate[] = [
  {
    id: 'pm.learn',
    label: '梳理产品方法与判断口径',
    taskKind: TASK_KIND.learn,
    defaultMinutes: 25,
    supportedFormats: allFormatIds,
  },
  {
    id: 'pm.drill',
    label: '口头产品演练',
    taskKind: TASK_KIND.drill,
    defaultMinutes: 20,
    supportedFormats: allFormatIds,
  },
  {
    id: 'pm.review',
    label: '复习薄弱产品能力',
    taskKind: TASK_KIND.review,
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'pm.fallback-script',
    label: '准备产品兜底话术',
    taskKind: TASK_KIND.fallbackScript,
    defaultMinutes: 10,
    supportedFormats: allFormatIds,
  },
];

export const productManagerRolePack: RolePack = {
  manifest: {
    id: PRODUCT_MANAGER_ROLE_PACK_ID,
    version: PRODUCT_MANAGER_ROLE_PACK_VERSION,
    type: 'role-pack',
    displayName: '产品经理',
    description: '产品经理岗位的能力诊断、案例训练和模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [],
    dependencies: [
      { id: PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS.analyticsCase, version: '^1.0.0', optional: true },
      {
        id: PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS.portfolioReview,
        version: '^1.0.0',
        optional: true,
      },
    ],
  },
  roleMatchers: [
    {
      titlePatterns: [
        // 不枚举 senior/staff 之类前缀：前缀不参与匹配，反而容易漏掉没列到的写法
        '\\bproduct\\s+manager\\b',
        '\\bproduct\\s+owner\\b',
        '\\bproduct\\s+lead\\b',
        '\\bhead\\s+of\\s+product\\b',
        '(?:产品|商业产品|策略产品|数据产品|增长产品|国际化产品)经理',
        '(?:产品负责人|产品总监|产品策划|产品运营经理)',
      ],
      responsibilitySignals: [
        'product roadmap',
        'user research',
        'prioritization',
        'product requirements',
        'go-to-market',
        '产品路线图',
        '需求优先级',
        '用户调研',
        '产品规划',
        '数据指标',
      ],
      excludeSignals: [
        'data structures',
        'algorithms',
        'distributed systems',
        'code review',
        'sales pipeline',
        'customer success',
        '算法',
        '分布式',
        '代码评审',
        '销售漏斗',
      ],
    },
  ],
  competencyTemplates,
  interviewStages,
  interviewFormats,
  rubrics,
  taskTemplates,
  promptFragments,
  sourcePolicy: {
    preferredDomains: [
      'woshipm.com',
      'pmcaff.com',
      'lenny.substack.com',
      'svpg.com',
      'mindtheproduct.com',
      'nowcoder.com',
      'zhihu.com',
      '1point3acres.com',
    ],
    credibilityOverrides: {
      'svpg.com': 5,
      'lenny.substack.com': 4,
      'mindtheproduct.com': 4,
      'woshipm.com': 3,
      'pmcaff.com': 3,
      'nowcoder.com': 3,
      'zhihu.com': 3,
      '1point3acres.com': 3,
    },
    freshnessDays: {
      companyIntel: 7,
      interviewReports: 3,
      // 产品方法论的变化比技术栈慢，放宽到两年仍然可用
      domainKnowledge: 730,
    },
  },
};
