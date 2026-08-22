import type { ExamForm } from '@shared/enums';

export type MockInterviewKind = ExamForm | 'selfIntro';
export type MockInterviewType = MockInterviewKind | 'mixed';
export type MockInterviewLanguage = 'zh' | 'en';

export interface DesignCaseGenerated {
  interviewType: MockInterviewKind;
  relatedNodeName?: string | null;
  title: string;
  scenarioMd: string;
  constraints: string[];
  evaluationCriteria: string[];
}

export interface DesignScoreGenerated {
  score: number;
  feedbackMd: string;
  improvedOutlineMd: string;
}

export interface DesignAnswerGenerated {
  answerMd: string;
}

/** 仅自我介绍题型使用英文；其它题型固定中文，避免语言设置泄漏 */
export function effectiveInterviewLanguage(
  interviewType: MockInterviewType,
  interviewLanguage: MockInterviewLanguage,
): MockInterviewLanguage {
  return interviewType === 'selfIntro' ? interviewLanguage : 'zh';
}

export function designCaseCacheId(
  campaignId: string,
  interviewType: MockInterviewType,
  interviewLanguage: MockInterviewLanguage,
): string {
  const lang = effectiveInterviewLanguage(interviewType, interviewLanguage);
  return `${campaignId}:${interviewType}:${lang}`;
}

const CASE_OUTPUT_SCHEMA = `输出 JSON：
{
  "interviewType": "concept|coding|design|scenario|selfIntro",
  "relatedNodeName": "关联考点名或 null",
  "title": "短标题",
  "scenarioMd": "markdown 题目正文（含追问提示）",
  "constraints": ["约束或考察点，可为空数组"],
  "evaluationCriteria": ["评分维度 3-6 条"]
}`;

const CASE_BASE_RULES = `你是资深面试官，根据公司背景、岗位 JD、候选人简历和考点清单，出一道贴近真实面试的题。
题目必须结合给定上下文，不要出与岗位无关的泛题。`;

export const MIXED_CASE_SYSTEM = `${CASE_BASE_RULES}

从 concept（概念八股）、coding（编码算法）、design（系统设计）、scenario（项目深挖/场景题）中选最合适的一类，
优先考察简历/JD 交集里的薄弱项或高频考点。

${CASE_OUTPUT_SCHEMA}`;

export const CONCEPT_CASE_SYSTEM = `${CASE_BASE_RULES}

题型：概念 / 八股 / 原理追问。围绕一个具体知识点，含 1-2 层追问。
${CASE_OUTPUT_SCHEMA}`;

export const CODING_CASE_SYSTEM = `${CASE_BASE_RULES}

题型：编码 / 算法 / 数据结构。给出明确输入输出与边界，难度匹配岗位职级。
${CASE_OUTPUT_SCHEMA}`;

export const DESIGN_CASE_SYSTEM = `${CASE_BASE_RULES}

题型：系统设计。场景具体，有业务背景和数据规模假设；约束 3-5 条（QPS、一致性、延迟、成本等）。
${CASE_OUTPUT_SCHEMA}`;

export const SCENARIO_CASE_SYSTEM = `${CASE_BASE_RULES}

题型：项目深挖 / 行为场景。围绕简历项目或 JD 职责，追问决策、权衡、踩坑与复盘。
${CASE_OUTPUT_SCHEMA}`;

export const SELF_INTRO_CASE_SYSTEM = `${CASE_BASE_RULES}

题型：自我介绍。请围绕候选人的岗位目标、简历亮点、核心项目和与 JD 的匹配度，给出一段真实面试开场自我介绍题。
题目里要明确时长要求（如 60-90 秒）和 1-2 个可能追问方向。
${CASE_OUTPUT_SCHEMA}`;

export function caseSystemForType(type: MockInterviewType): string {
  switch (type) {
    case 'concept':
      return CONCEPT_CASE_SYSTEM;
    case 'coding':
      return CODING_CASE_SYSTEM;
    case 'design':
      return DESIGN_CASE_SYSTEM;
    case 'scenario':
      return SCENARIO_CASE_SYSTEM;
    case 'selfIntro':
      return SELF_INTRO_CASE_SYSTEM;
    default:
      return MIXED_CASE_SYSTEM;
  }
}

function languageInstruction(language: MockInterviewLanguage): string {
  return language === 'en'
    ? '请用英文模拟真实面试：题目、追问、评分反馈和改进稿都使用英文。'
    : '请用中文模拟真实面试：题目、追问、评分反馈和改进稿都使用中文。';
}

export function caseUserHintForType(
  type: MockInterviewType,
  language: MockInterviewLanguage = 'zh',
): string {
  const languageHint = languageInstruction(language);
  if (type === 'mixed') return `${languageHint}\n请根据候选人背景自动选择最合适的题型并出题。`;
  const labels: Record<MockInterviewKind, string> = {
    concept: '概念 / 八股',
    coding: '编码 / 算法',
    design: '系统设计',
    scenario: '项目 / 场景',
    selfIntro: '自我介绍',
  };
  return `${languageHint}\n请出一道【${labels[type]}】类型的面试题。`;
}

const SCORE_BASE = `你是面试评委。按 1-5 分评分（5=能扛追问），给出逐点反馈和改进后的口语答题稿（markdown）。
输出 JSON：
{
  "score": 1-5,
  "feedbackMd": "逐点反馈",
  "improvedOutlineMd": "改进后的答题稿/大纲"
}`;

export const SCORE_SYSTEM_BY_TYPE: Record<ExamForm, string> = {
  concept: `${SCORE_BASE}\n侧重：概念准确性、原理深度、能否讲清 trade-off。`,
  coding: `${SCORE_BASE}\n侧重：思路清晰度、复杂度分析、边界与测试意识。`,
  design: `${SCORE_BASE}\n侧重：需求澄清、架构划分、扩展性与关键权衡。`,
  scenario: `${SCORE_BASE}\n侧重：STAR 结构、个人贡献真实性、决策复盘深度。`,
};

export const SELF_INTRO_SCORE_SYSTEM = `${SCORE_BASE}
侧重：开场结构、岗位匹配度、亮点可信度、表达自然度、能否引导后续追问。`;

export function scoreSystemForType(
  type: MockInterviewKind,
  language: MockInterviewLanguage = 'zh',
): string {
  const base = type === 'selfIntro' ? SELF_INTRO_SCORE_SYSTEM : SCORE_SYSTEM_BY_TYPE[type];
  return `${base}\n${languageInstruction(language)}`;
}

const ANSWER_BASE = `你是资深面试官兼面试教练。根据题目与候选人背景，给出一份高质量的「参考答案」草稿（markdown），适合口头作答。
要求：结构清晰、口语化、结合题目约束；不要写评分或点评，只写答案正文。
输出 JSON：{ "answerMd": "..." }`;

export const SELF_INTRO_ANSWER_SYSTEM = `${ANSWER_BASE}
侧重：60-90 秒自我介绍结构、岗位匹配、核心项目亮点。`;

export const ANSWER_SYSTEM_BY_TYPE: Record<ExamForm, string> = {
  concept: `${ANSWER_BASE}\n侧重：结论先行、原理深度、trade-off 与例子。`,
  coding: `${ANSWER_BASE}\n侧重：思路、核心算法、复杂度与边界。`,
  design: `${ANSWER_BASE}\n侧重：需求澄清、架构、关键模块与扩展权衡。`,
  scenario: `${ANSWER_BASE}\n侧重：STAR 结构、个人贡献、决策与复盘。`,
};

export function answerSystemForType(
  type: MockInterviewKind,
  language: MockInterviewLanguage = 'zh',
): string {
  const base = type === 'selfIntro' ? SELF_INTRO_ANSWER_SYSTEM : ANSWER_SYSTEM_BY_TYPE[type];
  return `${base}\n${languageInstruction(language)}`;
}
