import type { ExamForm } from '@shared/enums';

export type MockInterviewType = ExamForm | 'mixed';

export interface DesignCaseGenerated {
  interviewType: ExamForm;
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

const CASE_OUTPUT_SCHEMA = `输出 JSON：
{
  "interviewType": "concept|coding|design|scenario",
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
    default:
      return MIXED_CASE_SYSTEM;
  }
}

export function caseUserHintForType(type: MockInterviewType): string {
  if (type === 'mixed') return '请根据候选人背景自动选择最合适的题型并出题。';
  const labels: Record<ExamForm, string> = {
    concept: '概念 / 八股',
    coding: '编码 / 算法',
    design: '系统设计',
    scenario: '项目 / 场景',
  };
  return `请出一道【${labels[type]}】类型的面试题。`;
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

export function scoreSystemForType(type: ExamForm): string {
  return SCORE_SYSTEM_BY_TYPE[type];
}
