import type { CoverageType, EdgeRelation, ExamForm, MasterySource, NodeKind, NodeStatus } from '@shared/enums';
import { computePriority } from '@shared/priority';
import type { GeneratedNode } from './prompts';

/**
 * 能否继续细化这个考点。
 *
 * 考点树只有三层：domain（领域）→ topic（主题）→ point（考点）。建树一次生成
 * 前两层，细化产出的一律是 point（见 flattenChildren 里写死的 kind），所以 point
 * 已经是最细一层，再往下拆不出新的层级含义——只会得到一堆同样叫 point、深度
 * 只存在于 parentId 链里而没人读的节点。
 *
 * 这条线必须由后端把关，不能只靠 UI 隐藏按钮：细化有三个入口——桌面 UI、手机
 * UI、以及 sync/rpc 暴露给对端的 expandNode——UI 门槛挡不住后两个。
 *
 * 不封顶的代价不只是清单变长。排程把所有非 domain 节点都当可排期单元
 * （见 plan/schedule.ts 的 kind !== 'domain'），所以细化不是把父节点拆开，而是
 * 在它自己那条任务之外再加 3-6 条；每多一层乘 3-6，对着默认 90 分钟/天的预算，
 * 多两层就排不下了。加上去重是全战役范围的，深层候选大概率撞上已有名字被跳过，
 * 那一次模型调用换不回任何新考点。
 */
export function canExpandNode(kind: NodeKind): boolean {
  return kind === 'domain' || kind === 'topic';
}

export const EXPAND_DEPTH_LIMIT_MESSAGE = '这已经是最细一层考点，不能再细化';

export interface KnowledgeNodeInsert {
  id: string;
  campaignId: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  coverageType: CoverageType;
  examProb: number;
  difficulty: number;
  estMinutes: number;
  examForms: ExamForm[];
  mastery: number;
  masterySource: MasterySource;
  priorityScore: number;
  status: NodeStatus;
  isUserAdded: boolean;
  createdAt: number;
}

const COVERAGE_VALUES: CoverageType[] = ['deepDive', 'gap', 'landmine', 'extra'];

function validCoverage(v: unknown): CoverageType {
  return typeof v === 'string' && (COVERAGE_VALUES as string[]).includes(v)
    ? (v as CoverageType)
    : 'gap';
}

/**
 * 把 LLM 生成的嵌套考点树拍平成待插入的行。
 *
 * `newId` 必须由调用方传进来，不给默认值：这里曾经直接用 `globalThis.crypto.randomUUID()`，
 * 桌面端（Node）有这个全局，React Native 没有，于是手机端一诊断就抛
 * 「Cannot read property 'randomUUID' of undefined」——而 clearCampaignNodes 已经先把
 * 旧考点删了，用户看到的就是「点了诊断，考点全没了」。做成必填参数，
 * 类型检查会逼每个调用方自己交代 ID 从哪来，这类事故不会再悄悄回来。
 */
export function flattenGeneratedTree(
  campaignId: string,
  nodes: GeneratedNode[],
  newId: () => string,
): KnowledgeNodeInsert[] {
  const out: KnowledgeNodeInsert[] = [];
  const now = Date.now();
  const globalNames: string[] = [];

  const walk = (items: GeneratedNode[], parentId: string | null): void => {
    const accepted: string[] = [];
    for (const item of items) {
      if (accepted.some((a) => isNearDuplicate(a, item.name))) continue;
      const norm = normalizeName(item.name);
      if (globalNames.includes(norm)) continue;
      accepted.push(item.name);
      globalNames.push(norm);
      const id = newId();
      const row: KnowledgeNodeInsert = {
        id,
        campaignId,
        parentId,
        name: item.name.trim(),
        kind: item.kind,
        coverageType: validCoverage(item.coverageType),
        examProb: clamp(toNum(item.examProb, 0), 0, 1),
        difficulty: clamp(Math.round(toNum(item.difficulty, 3)), 1, 5),
        estMinutes: Math.max(10, Math.round(toNum(item.estMinutes, 30))),
        examForms: validExamForms(item.examForms),
        mastery: 0,
        masterySource: 'self',
        priorityScore: 0,
        status: 'todo',
        isUserAdded: false,
        createdAt: now,
      };
      const { score } = computePriority({ ...row });
      out.push({ ...row, priorityScore: score });

      if (item.children?.length) walk(item.children, id);
    }
  };

  walk(nodes, null);
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function validExamForms(forms: unknown): ExamForm[] {
  const allowed: ExamForm[] = ['concept', 'coding', 'design', 'scenario'];
  if (!Array.isArray(forms)) return ['concept'];
  const filtered = forms.filter(
    (f): f is ExamForm => typeof f === 'string' && allowed.includes(f as ExamForm),
  );
  return filtered.length ? filtered : ['concept'];
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·、，,（）()/\\_-]/g, '');
}

function tokenize(name: string): string[] {
  const lower = name.toLowerCase();
  const latin = (lower.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
  const cjk = lower
    .replace(/[a-z0-9]+/g, ' ')
    .split('')
    .filter((c) => /[\u4e00-\u9fff]/.test(c) && !'与和及的了之而在对于被把'.includes(c));
  return latin.concat(cjk);
}

function isNearDuplicate(a: string, b: string): boolean {
  if (normalizeName(a) === normalizeName(b)) return true;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return false;
  const bigger = ta.length >= tb.length ? ta : tb;
  const smaller = ta.length >= tb.length ? tb : ta;
  return smaller.every((t) => bigger.includes(t)) && bigger.length > smaller.length;
}

export type GeneratedEdgeSpec = { from: string; to: string; relation: EdgeRelation };
