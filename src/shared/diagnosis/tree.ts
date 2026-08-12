import type { CoverageType, EdgeRelation, ExamForm, MasterySource, NodeKind, NodeStatus } from '@shared/enums';
import { computePriority } from '@shared/priority';
import type { GeneratedNode } from './prompts';

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

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function validCoverage(v: unknown): CoverageType {
  return typeof v === 'string' && (COVERAGE_VALUES as string[]).includes(v)
    ? (v as CoverageType)
    : 'gap';
}

export function flattenGeneratedTree(campaignId: string, nodes: GeneratedNode[]): KnowledgeNodeInsert[] {
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
