import type { CoverageType, EdgeRelation, ExamForm, NodeKind } from '@shared/enums';
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

/** LLM 给出的知识点横向关系，按名称引用节点 */
export interface GeneratedEdge {
  from: string;
  to: string;
  relation: EdgeRelation;
}

export interface JdDiagnosisResult {
  jdParsed: JdParsed;
  nodes: GeneratedNode[];
  edges?: GeneratedEdge[];
}

export interface CrossAnalyzeResult {
  updates: Array<{ nodeName: string; coverageType: CoverageType }>;
}

export interface ExpandNodeResult {
  children: GeneratedNode[];
  edges?: GeneratedEdge[];
}

export interface ReportExtractResult {
  questions: string[];
}

export const JD_SYSTEM = `你是面试备考诊断助手。根据岗位 JD 抽取技能要求，并生成两层知识点树：
- 第一层 kind=domain（领域，3-6 个）
- 第二层 kind=topic（主题，每个 domain 下 2-5 个）

每个知识点需给出：examProb(0-1)、difficulty(1-5)、estMinutes、examForms(concept/coding/design/scenario 数组)。
difficulty 是“备考顺序”的唯一主排序依据，必须拉开梯度：
- 1=基础（概念、原理、常识性知识）
- 2=入门（常见用法、API、套路）
- 3=进阶（原理应用、典型场景）
- 4=深入（底层机制、实现细节）
- 5=专家级（跨模块整合、系统性设计）
同一层级的兄弟节点之间 difficulty 必须尽量分散（例如同层尽量覆盖 1/3/5 或 2/4 等不同档位），严禁全部相同。
 严禁出现重复知识点：同一 domain 下的兄弟节点、以及不同层级之间，名称不得含义重叠（例如「Python与AI/ML生态」与「Python AI/ML 生态与数据处理基础」只能保留一个；「数据清洗」与「数据清洗与特征工程」视作重叠，合并为一个）。
 domain 的 difficulty = 该领域对候选人的认知深度要求（用于领域间排序）。
尚未提供简历时，coverageType 一律填 gap（JD 要求但简历未知）。

同时给出知识点之间的横向关系 edges（from/to 必须是上面出现过的节点名）：
- prerequisite: from 是 to 的前置，不先懂 from 就学不动 to（这决定学习顺序，最重要）
- related: 常被一起追问
- contrast: 常被拿来对比

只给确实存在的关系，宁缺毋滥；prerequisite 不允许成环。

输出 JSON：
{
  "jdParsed": { "roleTitle": "", "requirements": [{"skill":"","weight":0.0}], "seniority": null },
  "nodes": [{ "name":"","kind":"domain","examProb":0.5,"difficulty":3,"estMinutes":30,"examForms":["concept"],"coverageType":"gap","children":[...] }],
  "edges": [{ "from":"内存模型","to":"volatile 语义","relation":"prerequisite" }]
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
 严禁生成含义重叠的子知识点：兄弟节点名称不得互相包含或近义（如「数据处理」与「数据处理基础」只能保留一个）。
 difficulty 锚点：1=基础概念，2=入门用法，3=进阶应用，4=底层机制，5=专家级整合；兄弟节点难度必须拉开梯度，严禁全部相同。
另给出这些子知识点之间的 edges（relation 取 prerequisite/related/contrast，from/to 用子知识点名）。
输出 JSON：{ "children": [{ "name":"","kind":"point", ... }], "edges": [{"from":"","to":"","relation":"prerequisite"}] }`;

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
