import type { ExamForm } from '@shared/enums';
import { CODE_FENCE_RULE_IN_JSON } from '../prompts/format';

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

const CASE_OUTPUT_SCHEMA = `${CODE_FENCE_RULE_IN_JSON}
输出 JSON：
{
  "interviewType": "concept|coding|design|scenario|selfIntro",
  "relatedNodeName": "关联考点名或 null",
  "title": "短标题",
  "scenarioMd": "markdown 题目正文（含追问提示）",
  "constraints": ["约束或考察点，可为空数组"],
  "evaluationCriteria": ["评分维度 3-6 条"]
}`;

const CASE_BASE_RULES = `你是资深面试官，根据公司背景、岗位 JD、候选人简历和考点清单，出一道贴近真实面试的题。
题目必须结合给定上下文，不要出与岗位无关的泛题。
题目涉及候选人经历时，优先取最近的那几段——上下文里的简历经历已按时间倒序给出，序号越小越近。
一道题只围绕一段经历，不要把几个项目拼成一道题：拼出来的题候选人没法用真实经历回答。`;

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
${CODE_FENCE_RULE_IN_JSON}
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
${CODE_FENCE_RULE_IN_JSON}
输出 JSON：{ "answerMd": "..." }`;

/**
 * 参考答案的取材规则。
 *
 * 三条都是「不写模型就不会做」的事：
 * - 不说优先最近，它会挑简历里描述最丰满的那段来答，而那常常是三四年前的项目。
 *   面试官问的是你现在什么水平，拿旧项目当主线等于自降职级。
 * - 不说锚定单一经历，它会把几段经历的亮点拼成一个「综合最优答案」——听起来
 *   很强，但没有哪一段是真实发生过的，面试官顺着追问两句就穿帮。
 * - 不说别编，它会为了答案完整自己补上简历里没有的指标和技术栈。
 */
const ANSWER_RECENCY_RULE = `- 优先用最近的经历。上下文里的简历经历已按时间倒序给出，序号越小越近，优先取靠前的；更早的经历只在最近经历确实覆盖不到考察点时才用，用的时候说清是哪一年的事。`;

const ANSWER_SINGLE_ANCHOR_RULE = `- 整个答案只锚定一段经历，不要把多个项目的架构、指标、踩坑混进同一条叙述线——那会拼出一个并不存在的项目。确实需要第二段经历佐证时，另起一句并点名（如「另外在 X 项目里也遇到过类似的问题……」），不要和主线交织。`;

const ANSWER_SEQUENTIAL_RULE = `- 会覆盖多段经历，按时间倒序一段一段讲：讲完一段再进入下一段，不要在几段之间来回跳，也不要把这一段的成果安到那一段头上。篇幅向最近一段倾斜，越早的越简略。`;

const ANSWER_NO_FABRICATION_RULE = `- 简历里没有的经历、指标、技术栈一律不要编；简历没写清楚的地方宁可说得笼统一点，也不要用「提升性能」「优化架构」等空话把缺口填成具体故事。`;

const SELF_INTRO_RESUME_ONLY_RULE = `- 自我介绍是复述候选人自己的履历，不是写理想候选人。公司情报、JD、面经里的技术栈只用来写「为什么投这个岗位」，不能当成候选人做过的事。`;

const SELF_INTRO_TRACEABLE_FACT_RULE = `- 凡涉及公司名、项目名、职责、技术栈、业务场景、数据指标，必须能在上文「自我介绍唯一事实来源」里找到对应表述；找不到就删掉或改成不含具体细节的笼统说法，绝不自己填数字或技术名词。`;

const SELF_INTRO_STRUCTURE_RULE = `- 建议结构：开场身份（岗位与年限，来自简历）→ 按时间倒序讲 1-2 段最近经历各 1-2 个亮点（只念简历里写过的）→ 与目标岗位的匹配（用简历事实对照 JD）→ 简短收尾。全流程控制在 60-90 秒口语长度，宁可短而真，也不要长而虚。`;

function answerSourcingRules(...rules: string[]): string {
  return `取材规则：\n${rules.join('\n')}`;
}

const ANCHORED_SOURCING = answerSourcingRules(
  ANSWER_RECENCY_RULE,
  ANSWER_SINGLE_ANCHOR_RULE,
  ANSWER_NO_FABRICATION_RULE,
);

export const SELF_INTRO_ANSWER_SYSTEM = `${ANSWER_BASE}
题型：自我介绍参考答案。
${answerSourcingRules(
  SELF_INTRO_RESUME_ONLY_RULE,
  SELF_INTRO_TRACEABLE_FACT_RULE,
  ANSWER_RECENCY_RULE,
  ANSWER_SEQUENTIAL_RULE,
  ANSWER_NO_FABRICATION_RULE,
  SELF_INTRO_STRUCTURE_RULE,
)}`;

export const ANSWER_SYSTEM_BY_TYPE: Record<ExamForm, string> = {
  concept: `${ANSWER_BASE}\n侧重：结论先行、原理深度、trade-off 与例子。\n${ANCHORED_SOURCING}`,
  coding: `${ANSWER_BASE}\n侧重：思路、核心算法、复杂度与边界。\n${ANCHORED_SOURCING}`,
  design: `${ANSWER_BASE}\n侧重：需求澄清、架构、关键模块与扩展权衡。\n${ANCHORED_SOURCING}`,
  scenario: `${ANSWER_BASE}\n侧重：STAR 结构、个人贡献、决策与复盘。\n${ANCHORED_SOURCING}`,
};

export function answerSystemForType(
  type: MockInterviewKind,
  language: MockInterviewLanguage = 'zh',
): string {
  const base = type === 'selfIntro' ? SELF_INTRO_ANSWER_SYSTEM : ANSWER_SYSTEM_BY_TYPE[type];
  return `${base}\n${languageInstruction(language)}`;
}

/** 生成参考答案时附在用户消息末尾的取材提醒 */
export function answerUserHintForType(
  type: MockInterviewKind,
  language: MockInterviewLanguage = 'zh',
): string {
  const languageHint = languageInstruction(language);
  if (type === 'selfIntro') {
    return `${languageHint}
请根据上文「自我介绍唯一事实来源」中的简历原文，写一段可直接开口说的自我介绍参考答案。
不要补充简历里没有的公司、项目、指标或技术栈；JD 只用于说明为什么应聘，不得捏造匹配经历。`;
  }
  return languageHint;
}
