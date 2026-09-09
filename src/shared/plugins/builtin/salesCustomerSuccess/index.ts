/**
 * 销售 / 客户成功岗位包。
 *
 * 与产品经理包一样自带全部 Prompt 片段，不引用 Core 的工程 prompt。这个岗位还多
 * 压着一件事：它是第一个真正需要「实时对话」的岗位——客户对话和商务谈判的质量
 * 体现在听懂了没有、追问对不对、被顶回来之后怎么走，这些在一问一答的文本里只能
 * 看到影子。角色扮演能力（role-play）因此被声明成可选依赖而不是必需依赖。
 *
 * 降级的落点在 interviewStages 上，而不是在 Core 里加判断：需要对话的那两轮
 * 同时列出 role-play 与文本行为题两个题型 ID，宿主按可用性取第一个。这样没装
 * 插件的用户拿到的是一份完整的、全部由文本行为题构成的面试蓝图，而不是两轮空白。
 * 由此得到一条可以被测试守住的性质：每条能力、每一轮都至少有一个不依赖任何
 * 能力插件的题型。
 *
 * 评分维度刻意不含技术准确性、吞吐、容量这类工程口径——销售岗位的高分与低分
 * 差在能不能问出真实痛点、能不能把价值说到对方的衡量标准上，与实现细节无关。
 */

import type { TaskKind } from '../../../enums';
import type {
  CompetencyTemplate,
  InterviewFormatDefinition,
  InterviewStageTemplate,
  PromptFragmentSet,
  RolePack,
  RubricAnchors,
  RubricDefinition,
  TaskTemplate,
} from '../../types';

export const SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID = 'sales-customer-success';
export const SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION = '1.0.0';

/**
 * 可选能力：装了才有实时角色扮演，没装时对话轮退回文本行为题。
 *
 * 由 T19 交付；在它落地之前这个包必须能独立成立，否则「可选」只是写在清单里的
 * 一个词。
 */
export const SALES_ROLE_PLAY_CAPABILITY_ID = 'role-play';

export const SALES_CUSTOMER_SUCCESS_FORMAT_IDS = {
  behavioral: 'sales.behavioral',
  customerRolePlay: 'sales.customer-role-play',
} as const;

export const SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS = {
  discovery: 'sales.discovery',
  valueArticulation: 'sales.value-articulation',
  objectionHandling: 'sales.objection-handling',
  negotiation: 'sales.negotiation',
  pipeline: 'sales.pipeline',
} as const;

export const SALES_CUSTOMER_SUCCESS_RUBRIC_IDS = {
  behavioral: 'sales.behavioral-rubric',
  rolePlay: 'sales.role-play-rubric',
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

const allFormatIds = Object.values(SALES_CUSTOMER_SUCCESS_FORMAT_IDS);


/**
 * 岗位包自带的 Prompt 片段。
 *
 * 每段只描述「销售岗位这一步该怎么问、怎么看」，角色、输出格式和事实来源规则
 * 由 Core 独占，组合器会在片段之前注入。
 */
const promptFragments: PromptFragmentSet = {
  diagnosis: [
    '## 销售岗位诊断侧重',
    '- 按成交流程拆解 JD：客户诊断、价值表达、异议处理、商务谈判、管道与预测。',
    '- 分清岗位是新签、续约还是客户成功：三者对同一条职责的要求不同，不要合并成一条通用销售能力。',
    '- 客户所属行业只用来判断销售周期长短和决策链复杂度，不要把行业知识本身当成考点。',
    '- 产品与技术相关要求只收敛到「能否把能力讲成客户的收益」，不展开成实现细节。',
    '- 每条职责都要落到可被行为题或对话题考到的能力上；落不下去的先记为未覆盖，不要凑一个相近的能力。',
  ].join('\n'),
  explanation: [
    '## 销售方法讲解侧重',
    '- 先讲这个方法在客户那一侧解决什么问题，再讲话术结构，最后给一个可照着说的样例。',
    '- 用一个具体的客户场景贯穿讲解，避免只停在方法论缩写。',
    '- 明确适用边界：什么类型的客户或什么阶段用这个方法会适得其反。',
  ].join('\n'),
  questionGeneration: {
    [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral]: [
      '## 销售行为面出题',
      '- 围绕候选人真实经历过的单子提问：客户是谁、当时卡在哪一步、他做了什么、结果如何。',
      '- 追问要往具体处走：这句话是谁说的、对方的顾虑原文是什么、报价怎么定的、最后由谁签的。',
      '- 丢掉的单子和赢下的单子都要问：只问赢的会让复述变成宣传。',
      '- 一次只追一个点，不要把多个问题合成一句。',
    ].join('\n'),
    [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay]: [
      '## 客户对话模拟出题',
      '- 先交代场景：客户角色与职级、所处采购阶段、预算与时间约束、以及一个尚未说出口的真实顾虑。',
      '- 用客户的口吻讲话，一次只给一个信息点，不要主动把顾虑全盘托出。',
      '- 候选人问到点子上就多给一层信息，问得笼统就只给笼统的回答——信息量随提问质量变化。',
      '- 中途至少抛出一次立场对立的回应（比价、拖延或质疑效果），看候选人如何接。',
      '- 不要替候选人总结，也不要在对话中评价他的表现。',
    ].join('\n'),
  },
  scoring: {
    [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral]: [
      '## 销售行为面评分侧重',
      '- 先分清个人动作与团队结果：说不清自己具体说了什么做了什么的，客户诊断维度不能给到 3 分以上。',
      '- 看客户的真实决策依据被挖到了哪一层：预算、决策人、替代方案和不采购的后果。',
      '- 业绩要有可追溯的口径（周期、金额量级、完成率的分母），只有「超额完成」这类表述不作为证据。',
      '- 看对丢单的归因是否落在自己可改进的动作上，把原因全部归给价格或产品的不给高分。',
      '- 按能否推进客户决策评分，与候选人是否熟悉产品实现无关。',
    ].join('\n'),
    [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay]: [
      '## 客户对话模拟评分侧重',
      '- 逐轮看：客户说的话里有没有被接住的信息，候选人是复述、追问还是直接跳到方案。',
      '- 看提问是否在缩小不确定性，连续的封闭式提问不算挖需求。',
      '- 被顶回来之后的一到两轮最能说明问题：是重复原话、让步，还是换一个角度重新对齐。',
      '- 结尾要看有没有拿到一个具体的下一步（时间、参与人、要交付什么），只留下「保持联系」不算推进。',
      '- 语速与措辞流畅不加分，客户的顾虑有没有被真正处理才加分。',
    ].join('\n'),
  },
  answerCoaching: {
    [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral]: [
      '## 销售行为面话术辅导',
      '- 按「客户处境 — 我做的动作 — 对方的反应 — 结果与口径」组织，动作要能还原到一句原话。',
      '- 业绩数字只用证据里出现过的口径，缺分母的数字就把它说成量级而不是精确值。',
      '- 丢单的经历先说自己判断偏在哪，再说改了什么，不要停在外部原因上。',
    ].join('\n'),
    [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay]: [
      '## 客户对话模拟话术辅导',
      '- 开场先确认对方最关心的一件事，再决定讲什么，不要一上来铺产品。',
      '- 每接一句话都带一个具体的追问，把范围往下收一层。',
      '- 被质疑时先把对方的顾虑用自己的话复述一遍再回应。',
      '- 结束前主动提出一个明确的下一步，并确认时间与参与人。',
    ].join('\n'),
  },
  debrief: [
    '## 销售面试复盘侧重',
    '- 按成交流程归类暴露出来的问题：是没问出痛点、没说到对方的衡量标准，还是没能推进到下一步。',
    '- 客户对话轮要回看具体是哪一句被漏掉了，而不是笼统记「沟通需要加强」。',
    '- 每条待改进都配一个可以在下次对话里直接用的动作或问法。',
  ].join('\n'),
};

/**
 * 五项能力覆盖成交全流程，默认权重之和为 1。
 *
 * 每一项的 supportedFormats 都至少包含文本行为题：没装角色扮演插件时，五项能力
 * 仍然都有地方可练、可考。
 */
const competencyTemplates: CompetencyTemplate[] = [
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.discovery,
    name: '客户诊断与需求挖掘',
    category: 'skill',
    description: '通过提问和倾听搞清客户的真实处境、决策链与不采购的后果',
    defaultWeight: 0.22,
    levelIndicators: [
      { level: 1, behavior: '照着话术念，客户说什么都接不上' },
      { level: 3, behavior: '能问出预算、决策人和当前替代方案' },
      { level: 5, behavior: '能挖到客户自己还没说清的诉求，并识别决策链上的隐性反对者' },
    ],
    evidenceKinds: ['experience', 'skill', 'behavior'],
    supportedFormats: allFormatIds,
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.valueArticulation,
    name: '价值表达与方案匹配',
    category: 'skill',
    description: '把产品能力翻译成客户自己的衡量标准和业务收益',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只罗列功能，说不出对客户的意义' },
      { level: 3, behavior: '能把主要能力对应到客户的业务收益' },
      { level: 5, behavior: '能按不同角色（使用者、预算方、反对者）分别组织价值口径' },
    ],
    evidenceKinds: ['experience', 'achievement', 'skill'],
    supportedFormats: allFormatIds,
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.objectionHandling,
    name: '异议处理与信任建立',
    category: 'behavior',
    description: '面对质疑、比价和拖延时保持推进，同时不损耗长期信任',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '被质疑就让价或回避' },
      { level: 3, behavior: '能复述顾虑并给出针对性回应' },
      { level: 5, behavior: '能分辨真异议与借口，用第三方证据或试点方案化解' },
    ],
    evidenceKinds: ['behavior', 'experience'],
    supportedFormats: allFormatIds,
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.negotiation,
    name: '商务谈判与成交推进',
    category: 'skill',
    description: '在条款、价格和交付范围之间取舍，把客户推进到明确的下一步',
    defaultWeight: 0.18,
    levelIndicators: [
      { level: 1, behavior: '把谈判等同于报价，谈不到条款' },
      { level: 3, behavior: '能守住底线并换取对等条件' },
      { level: 5, behavior: '能设计让步顺序，用交付范围和周期换取价格与条款' },
    ],
    evidenceKinds: ['experience', 'achievement', 'behavior'],
    supportedFormats: allFormatIds,
  },
  {
    id: SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS.pipeline,
    name: '管道管理与预测',
    category: 'experience',
    description: '按阶段管理机会、判断真实成交概率并给出可信预测',
    defaultWeight: 0.2,
    levelIndicators: [
      { level: 1, behavior: '只按感觉判断单子进展' },
      { level: 3, behavior: '能按阶段标准判断机会真实性并解释依据' },
      { level: 5, behavior: '能解释预测偏差来源，并说明如何据此调整投入' },
    ],
    evidenceKinds: ['experience', 'achievement'],
    // 管道管理靠复盘历史机会来考，实时对话里问不出预测口径
    supportedFormats: [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral],
  },
];

/**
 * 需要实时对话的两轮同时列出 role-play 与文本行为题。
 *
 * 顺序即优先级：宿主取第一个可用的题型。role-play 没装时这两轮退回文本行为题，
 * 蓝图仍然是四轮，权重也不变——把轮次直接删掉会让阶段权重之和不再为 1，能力
 * 诊断里的 stageWeight 会跟着失真。
 */
const interviewStages: InterviewStageTemplate[] = [
  {
    id: 'sales.screen',
    label: '销售初筛',
    order: 0,
    formatIds: [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral],
    defaultWeight: 0.2,
  },
  {
    id: 'sales.discovery-conversation',
    label: '客户对话模拟',
    order: 1,
    formatIds: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    ],
    defaultWeight: 0.3,
  },
  {
    id: 'sales.deal-review',
    label: '成交复盘面',
    order: 2,
    formatIds: [SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral],
    defaultWeight: 0.25,
  },
  {
    id: 'sales.negotiation-conversation',
    label: '谈判模拟',
    order: 3,
    formatIds: [
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
      SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    ],
    defaultWeight: 0.25,
  },
];

const interviewFormats: InterviewFormatDefinition[] = [
  {
    id: SALES_CUSTOMER_SUCCESS_FORMAT_IDS.behavioral,
    label: '销售行为面',
    protocol: 'behavioral',
    defaultDurationMinutes: 40,
    followUpPolicy: { maxRounds: 4, strategy: 'adaptive' },
    rubricId: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.behavioral,
    // 刻意不绑 capabilityId：这是降级之后唯一还站得住的题型
  },
  {
    id: SALES_CUSTOMER_SUCCESS_FORMAT_IDS.customerRolePlay,
    label: '客户对话模拟',
    protocol: 'role-play',
    defaultDurationMinutes: 30,
    // 对话轮数比行为面多：一来一回才看得出听没听懂
    followUpPolicy: { maxRounds: 6, strategy: 'adaptive' },
    rubricId: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.rolePlay,
    capabilityId: SALES_ROLE_PLAY_CAPABILITY_ID,
  },
];

/**
 * 两份量规都不含技术准确性、吞吐、容量这类工程口径。
 *
 * 对话量规按计划取倾听、澄清、应变、推进四维：它们衡量的是一次真实对话里能被
 * 观察到的东西，与行为面看「过去做过什么、口径是否可追溯」是两回事，所以维度名
 * 与行为面不重叠——同名会让两种题型的历史分被放在一起比较。
 */
const rubrics: RubricDefinition[] = [
  {
    id: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.rolePlay,
    dimensions: [
      {
        id: 'listening',
        label: '倾听与信息接收',
        weight: 0.25,
        critical: true,
        anchors: anchors(
          '客户给出的信息被完全忽略，按预设话术推进',
          '能复述客户原话，但不影响下一句怎么说',
          '能接住关键信息并据此调整方向',
          '能听出客户没直说的顾虑并加以确认',
          '能分辨客户话里的事实、判断与情绪，并分别处理',
        ),
      },
      {
        id: 'clarifying',
        label: '澄清与提问质量',
        weight: 0.25,
        anchors: anchors(
          '不提问，或只问能用是否回答的问题',
          '提问零散，问完仍说不清客户处境',
          '提问在逐步缩小范围',
          '能围绕决策链和替代方案系统地问',
          '能用一个问题同时验证需求真实性与紧迫性',
        ),
      },
      {
        id: 'adaptability',
        label: '应变与立场处理',
        weight: 0.25,
        anchors: anchors(
          '被顶回来就让价或转移话题',
          '重复原话，不换角度',
          '能针对当下的顾虑给出新回应',
          '能区分真异议与借口，分别应对',
          '能在被否定后重新建立共同前提再推进',
        ),
      },
      {
        id: 'advancing',
        label: '推进与下一步',
        weight: 0.25,
        anchors: anchors(
          '对话结束时没有任何约定',
          '只留下「保持联系」这类模糊承诺',
          '拿到一个明确的下一步动作',
          '下一步带时间、参与人和交付物',
          '下一步与客户内部流程对齐，并留了推进的抓手',
        ),
      },
    ],
    passThreshold: 3,
    failConditions: ['倾听与信息接收为 1 分'],
  },
  {
    id: SALES_CUSTOMER_SUCCESS_RUBRIC_IDS.behavioral,
    dimensions: [
      {
        id: 'customer-diagnosis-depth',
        label: '客户诊断深度',
        weight: 0.3,
        critical: true,
        anchors: anchors(
          '说不出客户是谁、卡在哪一步',
          '只描述客户行业和规模',
          '能说清客户处境、预算与决策人',
          '能还原客户的替代方案和不采购的后果',
          '能说明当初判断偏在哪，以及靠哪个提问纠正过来',
        ),
      },
      {
        id: 'value-translation',
        label: '价值翻译',
        weight: 0.25,
        anchors: anchors(
          '只罗列产品功能',
          '有收益表述但与客户目标无关',
          '能把能力对应到客户的业务收益',
          '能按不同角色分别组织价值口径',
          '能用客户自己的考核指标来表述收益',
        ),
      },
      {
        id: 'trust-and-objection',
        label: '信任与异议',
        weight: 0.2,
        anchors: anchors(
          '面对质疑只会让价',
          '能回应质疑但不处理背后的顾虑',
          '能复述顾虑并给出针对性回应',
          '能用第三方证据或试点降低对方风险',
          '能在长期关系与本次成交之间做出取舍并说明理由',
        ),
      },
      {
        id: 'result-attribution',
        label: '结果与归因',
        weight: 0.25,
        anchors: anchors(
          '业绩表述没有任何口径',
          '给出数字但说不出周期和分母',
          '业绩口径清楚，可追溯',
          '能分清自己的动作与市场、产品带来的影响',
          '能从丢掉的单子里提炼出已经改进的具体动作',
        ),
      },
    ],
    passThreshold: 3,
    failConditions: ['客户诊断深度为 1 分'],
  },
];

/**
 * 四条任务模板都不挂 capabilityId。
 *
 * 准备成本因此与插件是否安装无关：没装角色扮演的用户也拿得到完整的每日计划，
 * 只是练的时候用文本行为题。
 */
const taskTemplates: TaskTemplate[] = [
  {
    id: 'sales.learn',
    label: '梳理成交流程与提问清单',
    taskKind: TASK_KIND.learn,
    defaultMinutes: 25,
    supportedFormats: allFormatIds,
  },
  {
    id: 'sales.drill',
    label: '口头客户对话演练',
    taskKind: TASK_KIND.drill,
    defaultMinutes: 20,
    supportedFormats: allFormatIds,
  },
  {
    id: 'sales.review',
    label: '复盘薄弱销售能力',
    taskKind: TASK_KIND.review,
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'sales.fallback-script',
    label: '准备异议与比价兜底话术',
    taskKind: TASK_KIND.fallbackScript,
    defaultMinutes: 10,
    supportedFormats: allFormatIds,
  },
];

export const salesCustomerSuccessRolePack: RolePack = {
  manifest: {
    id: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
    version: SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
    type: 'role-pack',
    displayName: '销售 / 客户成功',
    description: '销售与客户成功岗位的能力诊断、对话训练和模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [],
    dependencies: [
      { id: SALES_ROLE_PLAY_CAPABILITY_ID, version: '^1.0.0', optional: true },
    ],
  },
  roleMatchers: [
    {
      titlePatterns: [
        '\\b(?:account|sales)\\s+(?:executive|manager|director)\\b',
        '\\bsales\\s+(?:development|representative)\\b',
        '\\baccount\\s+manager\\b',
        '\\bcustomer\\s+success\\s+(?:manager|engineer|specialist)\\b',
        '\\bsolution\\s+consultant\\b',
        '\\bbusiness\\s+development\\b',
        // 岗位名后缀写成必需：裸一个「销售」会把「销售系统开发工程师」也收进来，
        // 而标题命中就直接入选，JD 里的 excludeSignals 未必拦得住
        '(?:销售|大客户销售|渠道销售|解决方案销售|电话销售)(?:经理|代表|专员|总监|顾问)',
        '(?:客户成功|客户)(?:经理|专员|总监)',
        '(?:商务拓展|渠道拓展|售前顾问)',
      ],
      responsibilitySignals: [
        'quota',
        'pipeline',
        'prospecting',
        'renewal',
        'upsell',
        'customer onboarding',
        '销售目标',
        '客户拓展',
        '续约',
        '回款',
        '商务谈判',
        '客户关系维护',
      ],
      excludeSignals: [
        'data structures',
        'system design',
        'code review',
        'product roadmap',
        'user research',
        '算法',
        '分布式',
        '代码评审',
        '需求优先级',
        '产品路线图',
      ],
    },
  ],
  competencyTemplates,
  interviewStages,
  interviewFormats,
  rubrics,
  taskTemplates,
  promptFragments,
  /**
   * 行业中立。
   *
   * 刻意不收录任何厂商的销售博客或垂直行业媒体：那些内容会把某一个产品的话术
   * 当成通用方法，而这个包要同时服务软件、制造和服务业的销售岗位。留下的是
   * 通用销售方法与面试经验两类来源。
   */
  sourcePolicy: {
    preferredDomains: [
      'hbr.org',
      'gartner.com',
      'mckinsey.com',
      'nowcoder.com',
      'zhihu.com',
      'linkedin.com',
      '1point3acres.com',
    ],
    credibilityOverrides: {
      'hbr.org': 5,
      'gartner.com': 4,
      'mckinsey.com': 4,
      'nowcoder.com': 3,
      'zhihu.com': 3,
      'linkedin.com': 3,
      '1point3acres.com': 3,
    },
    freshnessDays: {
      companyIntel: 7,
      interviewReports: 3,
      // 成交方法比产品形态更稳定，两年内的内容仍然可用
      domainKnowledge: 730,
    },
  },
};