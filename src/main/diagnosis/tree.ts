import { randomUUID } from 'node:crypto';
import type { CoverageType, ExamForm } from '@shared/enums';
import { computePriority } from './priority';
import type { GeneratedNode } from '@shared/diagnosis/prompts';
import type * as schema from '../db/schema';

type NodeInsert = typeof schema.knowledgeNode.$inferInsert;

const COVERAGE_VALUES: CoverageType[] = ['deepDive', 'gap', 'landmine', 'extra'];

function validCoverage(v: unknown): CoverageType {
  return typeof v === 'string' && (COVERAGE_VALUES as string[]).includes(v)
    ? (v as CoverageType)
    : 'gap';
}

/** 将两层 GeneratedNode 树展平为可插入数据库的行 */
export function flattenGeneratedTree(campaignId: string, nodes: GeneratedNode[]): NodeInsert[] {
  const out: NodeInsert[] = [];
  const now = Date.now();
  // 跨层完全同名拦截：树内域名/小主题与考点同名（规范化后相等）只保留先出现的
  const globalNames: string[] = [];

  const walk = (items: GeneratedNode[], parentId: string | null): void => {
    // 同层兄弟去重：LLM 常产出近义点（"Python与AI/ML生态" vs "Python AI/ML 生态与数据处理基础"），
    // 名称包含/token 覆盖即跳过，避免清单里出现重复考点
    const accepted: string[] = [];
    for (const item of items) {
      if (accepted.some((a) => isNearDuplicate(a, item.name))) continue;
      const norm = normalizeName(item.name);
      if (globalNames.includes(norm)) continue;
      accepted.push(item.name);
      globalNames.push(norm);
      const id = randomUUID();
      const row = {
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
        masterySource: 'self' as const,
        priorityScore: 0,
        status: 'todo' as const,
        isUserAdded: false,
        createdAt: now,
      };
      const { score } = computePriority({ ...row, id });
      out.push({ ...row, priorityScore: score });

      if (item.children?.length) {
        walk(item.children, id);
      }
    }
  };

  walk(nodes, null);
  return out;
}

export function flattenChildren(
  campaignId: string,
  parentId: string,
  parentCoverage: CoverageType,
  children: GeneratedNode[],
): NodeInsert[] {
  return flattenGeneratedTree(
    campaignId,
    children.map((c) => ({
      ...c,
      kind: 'point' as const,
      coverageType: c.coverageType ?? parentCoverage,
    })),
  ).map((row) => ({ ...row, parentId }));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** LLM 输出不可信：数字字段可能是字符串/缺失/null/NaN，统一净化为有限数 */
function toNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** LLM 输出不可信：examForms 可能是字符串/缺失，归一化为合法数组 */
function validExamForms(forms: unknown): ExamForm[] {
  const allowed: ExamForm[] = ['concept', 'coding', 'design', 'scenario'];
  if (!Array.isArray(forms)) return ['concept'];
  const filtered = forms.filter(
    (f): f is ExamForm => typeof f === 'string' && allowed.includes(f as ExamForm),
  );
  return filtered.length ? filtered : ['concept'];
}

/** 名称归一化后比较，用于细化时的简单去重（embedding 去重留到 embedding 角色配置后） */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·、，,（）()/\\_-]/g, '');
}

export function findDuplicateByName(
  existingNames: string[],
  candidate: string,
): string | null {
  const norm = normalizeName(candidate);
  for (const name of existingNames) {
    if (normalizeName(name) === norm) return name;
    // 包含关系也视为重复，避免「GC」与「垃圾回收」并存
    const n = normalizeName(name);
    if (n.includes(norm) || norm.includes(n)) return name;
  }
  return null;
}

/** 拆出命名 token：英文/数字词（长度≥2）+ 中文单字（滤掉连接助词）。基于原始名，勿先删空格，否则 AI/ML 会粘连 */
function tokenize(name: string): string[] {
  const lower = name.toLowerCase();
  const latin = (lower.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
  const cjk = lower
    .replace(/[a-z0-9]+/g, ' ')
    .split('')
    .filter((c) => /[\u4e00-\u9fff]/.test(c) && !'与和及的了之而在对于被把'.includes(c));
  return latin.concat(cjk);
}

/**
 * 兄弟近义判定：完全/互相包含，或短名的 token 全部出现在长名中
 * （「Python与AI/ML生态」⊆「Python AI/ML 生态与数据处理基础」→ 重复）。
 * 仅用于同层兄弟去重，避免清单里呈现近义考点。
 */
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
  // 短名的每个 token 都在长名出现且长名严格更全 → 超集重复
  return smaller.every((t) => bigger.includes(t)) && bigger.length > smaller.length;
}
