import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ExamForm } from '@shared/enums';
import type { KnowledgeNode } from '@shared/entities';
import type { CreateNodeInput, UpdateNodeInput } from '@shared/ipc';
import { getDb, schema } from '../db';
import { computePriority } from '../diagnosis/priority';
import { rowToNode } from './repository';

export function updateNode(input: UpdateNodeInput): KnowledgeNode {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, input.id))
    .get();
  if (!row) throw new Error('节点不存在');

  const next = rowToNode({
    ...row,
    name: input.name?.trim() ?? row.name,
    coverageType: input.coverageType ?? row.coverageType,
    status: input.status ?? row.status,
  });
  const { score } = computePriority(next);

  db.update(schema.knowledgeNode)
    .set({
      name: next.name,
      coverageType: next.coverageType,
      status: next.status,
      priorityScore: score,
    })
    .where(eq(schema.knowledgeNode.id, input.id))
    .run();

  return { ...next, priorityScore: score };
}

export function deleteNode(id: string): void {
  getDb().delete(schema.knowledgeNode).where(eq(schema.knowledgeNode.id, id)).run();
}

export function createNode(input: CreateNodeInput): KnowledgeNode {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const base = {
    id,
    campaignId: input.campaignId,
    parentId: input.parentId,
    name: input.name.trim(),
    kind: input.kind,
    coverageType: 'extra' as const,
    examProb: 0.3,
    difficulty: 3,
    estMinutes: 30,
    examForms: ['concept'] as ExamForm[],
    mastery: 0,
    masterySource: 'self' as const,
    priorityScore: 0,
    status: 'todo' as const,
    isUserAdded: true,
    quizQuestionMd: null,
    quizRecommendedAnswerMd: null,
    createdAt: now,
  };
  const { score } = computePriority(base);
  db.insert(schema.knowledgeNode).values({ ...base, priorityScore: score }).run();
  return { ...base, priorityScore: score };
}
