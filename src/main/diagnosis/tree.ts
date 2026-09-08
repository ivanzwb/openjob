import { randomUUID } from 'node:crypto';
import type { CoverageType, ExamForm } from '@shared/enums';
import { findSameLevelDuplicate, normalizeName } from '@shared/diagnosis/tree';
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
      if (findSameLevelDuplicate(accepted, item.name)) continue;
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