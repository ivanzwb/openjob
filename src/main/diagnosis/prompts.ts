import type { CoverageType, ExamForm, NodeKind } from '@shared/enums';
import type { JdParsed, ResumeParsed } from '@shared/entities';

/** LLM 返回的单个知识点（建树 / 细化共用） */
export interface GeneratedNode {
  name: string;
  kind: NodeKind;
  examProb: number;
  difficulty: number;
  estMinutes: number;
  examForms: ExamForm[];
  coverageType: CoverageType;
  children?: GeneratedNode[];
}

export interface JdDiagnosisResult {
  jdParsed: JdParsed;
  nodes: GeneratedNode[];
}

export interface CrossAnalyzeResult {
  updates: Array<{ nodeName: string; coverageType: CoverageType }>;
}

export interface ExpandNodeResult {
  children: GeneratedNode[];
}

export interface ReportExtractResult {
  questions: string[];
}

export const JD_SYSTEM = `你是面试备考诊断助手。根据岗位 JD 抽取技能要求，并生成两层知识点树：
- 第一层 kind=domain（领域，3-6 个）
- 第二层 kind=topic（主题，每个 domain 下 2-5 个）

每个 topic 需给出：examProb(0-1)、difficulty(1-5)、estMinutes、examForms(concept/coding/design/scenario 数组)。
尚未提供简历时，coverageType 一律填 gap（JD 要求但简历未知）。

输出 JSON：
{
  "jdParsed": { "roleTitle": "", "requirements": [{"skill":"","weight":0.0}], "seniority": null },
  "nodes": [{ "name":"","kind":"domain","examProb":0.5,"difficulty":3,"estMinutes":30,"examForms":["concept"],"coverageType":"gap","children":[...] }]
}`;

export const RESUME_SYSTEM = `你是简历解析助手。从简历原文抽取结构化信息。
输出 JSON：
{
  "skills": ["技能1"],
  "projects": [{"name":"","summary":"","drillableTopics":["可被深挖的点"]}],
  "yearsOfExperience": null
}`;

export function crossAnalyzeSystem(): string {
  return `你是 JD×简历交叉分析助手。根据 JD 要求与简历内容，为每个知识点判定覆盖类型：
- deepDive: 简历写了且 JD 明确要求
- gap: JD 要求但简历没有或很弱
- landmine: 简历写了但 JD 未提（容易被顺嘴问崩）
- extra: 相关但两边都不强调

输出 JSON：{ "updates": [{ "nodeName": "与输入完全一致的节点名", "coverageType": "gap" }] }
必须为每个输入节点都给出一条 update。`;
}

export function crossAnalyzeUser(
  jd: JdParsed,
  resume: ResumeParsed,
  nodeNames: string[],
): string {
  return JSON.stringify({ jdParsed: jd, resumeParsed: resume, nodes: nodeNames });
}

export const EXPAND_SYSTEM = `你是知识点细化助手。为给定主题生成 3-6 个子知识点（kind=point）。
保持名称具体、可独立备考。给出 examProb、difficulty、estMinutes、examForms、coverageType。
输出 JSON：{ "children": [{ "name":"","kind":"point", ... }] }`;

export const INTEL_SYSTEM = `你是面试情报分析师。根据检索到的公司面经与公开信息，生成结构化情报卡。
用 markdown 分段，简洁可执行。输出 JSON：
{
  "techStackMd": "技术栈与偏好",
  "interviewProcessMd": "面试流程与轮次",
  "hotTopicsMd": "近期高频考点",
  "talkingPointsMd": "反问环节可用素材"
}`;

export const REPORT_EXTRACT_SYSTEM = `从面经原文中提取独立的面试问题，每题一行语义完整。
输出 JSON：{ "questions": ["问题1", "问题2"] }`;

export interface ReportMatchResult {
  matches: Array<{
    questionIndex: number;
    nodeName: string | null;
    confidence: number;
    suggestedName?: string | null;
  }>;
}
