/**
 * 基础 Agent 的通用面试基线题型。
 *
 * 自我介绍不属任何岗位包——三个官方包的 golden 明确不许出现自我介绍类词条，
 * 因为它是跨岗位的通用能力，岗位包再写一份就会重复问一遍。题型声明迁进岗位包
 * 之后，练习页下拉只列包声明的题型，自我介绍随之下线（0.6.x 里它是第一个选项）。
 * 所以基线由基础包自己声明：宿主把基线题型排在岗位包题型前面，包若声明了同名
 * 题型则以包为准。
 *
 * 基线只带自己的面试形式与量规，不碰岗位包的 competencyTemplates /
 * interviewStages / taskTemplates——那些是岗位差异的落点，基线不参与。
 */
import type {
  ExamFormDefinition,
  InterviewFormatDefinition,
  RolePack,
  RubricDefinition,
} from '../plugins/types';
import { formatIdForExamForm } from '../plugins/examForms';
import { PracticeError } from './types';
import type { ResolvedPracticeFormat } from './rubric';

/** 自我介绍题型 id；沿用 0.6.x 的取值，旧数据（interview_type）里存的就是它。 */
export const SELF_INTRO_EXAM_FORM_ID = 'selfIntro';

export const CORE_SELF_INTRO_FORMAT_ID = 'core.self-intro';
export const CORE_SELF_INTRO_RUBRIC_ID = 'core.self-intro-rubric';

/**
 * 基线题型。
 *
 * 只有自称：formatId 指向基础包自己的面试形式，diagnosisHint 不写——基线不参与
 * 岗位包的诊断枚举（知识点考哪些题型是岗位的事）。
 */
export const BASELINE_EXAM_FORMS: ExamFormDefinition[] = [
  {
    id: SELF_INTRO_EXAM_FORM_ID,
    label: '自我介绍',
    formatId: CORE_SELF_INTRO_FORMAT_ID,
  },
];

export const BASELINE_INTERVIEW_FORMATS: InterviewFormatDefinition[] = [
  {
    id: CORE_SELF_INTRO_FORMAT_ID,
    label: '自我介绍',
    // 口述一段讲给自己的履历，面试官从里面挑一条往下问：形式上是陈述，不是知识问答
    protocol: 'presentation',
    defaultDurationMinutes: 5,
    followUpPolicy: { maxRounds: 2, strategy: 'adaptive' },
    rubricId: CORE_SELF_INTRO_RUBRIC_ID,
  },
];

export const BASELINE_RUBRICS: RubricDefinition[] = [
  {
    id: CORE_SELF_INTRO_RUBRIC_ID,
    dimensions: [
      {
        id: 'core.self-intro.structure',
        label: '结构与时长',
        weight: 0.25,
        anchors: {
          1: '没有开场，直接进入细节',
          2: '有开场但主线不清，几段经历来回跳',
          3: '开场、主线、匹配、收尾基本齐备',
          4: '结构清晰，篇幅向最近一段经历倾斜',
          5: '结构清楚、时长贴合要求，并留下可追问的钩子',
        },
      },
      {
        id: 'core.self-intro.fit',
        label: '岗位匹配',
        weight: 0.25,
        anchors: {
          1: '完全没有提到目标岗位',
          2: '只罗列技能，和岗位要求对不上',
          3: '岗位要求里的关键词各有简历事实对上',
          4: '匹配点用具体经历说明，而不是复述岗位描述',
          5: '匹配点覆盖岗位核心要求，并说清了为什么是这个方向',
        },
      },
      {
        id: 'core.self-intro.credibility',
        label: '履历可信度',
        weight: 0.3,
        critical: true,
        anchors: {
          1: '出现简历里没有的公司、项目或指标',
          2: '关键数字或技术栈与简历里的写法不一致',
          3: '公司、项目、职责、指标都能在简历里找到出处',
          4: '事实与简历一致，也没把团队成果说成一己之力',
          5: '细节都能追溯到简历原文，措辞克制不夸大',
        },
      },
      {
        id: 'core.self-intro.delivery',
        label: '表达与节奏',
        weight: 0.2,
        anchors: {
          1: '书面腔或背诵感明显，不像在说话',
          2: '句子过长，重点埋在中途',
          3: '口语化，能一口气讲完',
          4: '轻重分明，关键成果交代得清楚',
          5: '表达自然，节奏给面试官留出了追问空间',
        },
      },
    ],
    passThreshold: 3,
    failConditions: ['履历可信度为 1 分'],
  },
];

const FORMAT_BY_ID = new Map(BASELINE_INTERVIEW_FORMATS.map((format) => [format.id, format]));
const RUBRIC_BY_ID = new Map(BASELINE_RUBRICS.map((rubric) => [rubric.id, rubric]));
const FORMAT_ID_BY_EXAM_FORM = new Map(
  BASELINE_EXAM_FORMS.map((form) => [form.id, form.formatId]),
);

/** 基线面试形式与量规；不是基线题型时返回 null（调用方决定报错还是继续找包）。 */
export function resolveBaselineFormat(formatId: string): ResolvedPracticeFormat | null {
  const format = FORMAT_BY_ID.get(formatId);
  if (!format) return null;
  const rubric = RUBRIC_BY_ID.get(format.rubricId);
  if (!rubric) {
    throw new PracticeError(
      'unknown-rubric',
      `基线面试形式 ${formatId} 引用的量规 ${format.rubricId} 不存在`,
    );
  }
  return { format, rubric };
}

/** 题型 id → 练习格式 id：岗位包声明优先，其次基础包基线，都没有时返回空串。 */
export function practiceFormatIdForExamForm(
  rolePack: RolePack | null,
  examFormId: string,
): string {
  return formatIdForExamForm(rolePack, examFormId) || (FORMAT_ID_BY_EXAM_FORM.get(examFormId) ?? '');
}

/**
 * 练习页题型下拉的来源：基线在前、岗位包在后（0.6.x 的顺序）。
 *
 * 包声明了同名题型时以包为准：那说明这个岗位想按自己的措辞和量规问，基线让位。
 * 包没装时也返回基线——自我介绍不依赖任何岗位包。
 */
export function practiceExamForms(rolePack: RolePack | null): ExamFormDefinition[] {
  const packForms = rolePack?.examForms ?? [];
  const declared = new Set(packForms.map((form) => form.id));
  return [...BASELINE_EXAM_FORMS.filter((form) => !declared.has(form.id)), ...packForms];
}
