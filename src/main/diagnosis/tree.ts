import { randomUUID } from 'node:crypto';
import type { CoverageType, ExamForm } from '@shared/enums';
import { computePriority } from './priority';
import type { GeneratedNode } from './prompts';
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

  const walk = (items: GeneratedNode[], parentId: string | null): void => {
    for (const item of items) {
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
  return name.toLowerCase().replace(/\s+/g, '').replace(/[·、，,]/g, '');
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
