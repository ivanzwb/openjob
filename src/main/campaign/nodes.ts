import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { ExamForm } from '@shared/enums';
import type { KnowledgeNode } from '@shared/entities';
import type { CreateNodeInput, UpdateNodeInput } from '@shared/ipc';
import { EXPAND_DEPTH_LIMIT_MESSAGE, canExpandNode } from '@shared/diagnosis/tree';
import { collectSubtreeIds } from '@shared/knowledgeTree';
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

/**
 * 删掉这个考点连同它的整棵子树，返回删掉的行数。
 *
 * knowledge_node.parent_id 没有外键也没有级联，只删一行的话后代会留着一个指不到
 * 任何行的 parent_id：它们既不是根、又没有父节点会去递归，从考点清单里消失，可还
 * 在库里、还被排程、还算进统计（groupNodesByParent 现在会把这种行提到根上显示，
 * 于是表现成「删了一个专题，底下的考点全跑到最外层」）。两种都不是用户要的。
 *
 * 一条语句删完：SQLite 触发器逐行触发，每行照样在 oplog 里留下自己的墓碑，对端才
 * 会跟着删；同时不会留下半棵子树。node:delete 也通过 sync/rpc 暴露给对端，所以
 * 「删一个考点」的含义只能有一个，手机端用的是同一套规则。
 */
export function deleteNode(id: string): number {
  const db = getDb();
  const rows = db
    .select({ id: schema.knowledgeNode.id, parentId: schema.knowledgeNode.parentId })
    .from(schema.knowledgeNode)
    .all();

  const ids = collectSubtreeIds(rows, id);
  db.delete(schema.knowledgeNode).where(inArray(schema.knowledgeNode.id, ids)).run();

  return ids.length;
}

export function createNode(input: CreateNodeInput): KnowledgeNode {
  const db = getDb();

  // point 已经是最细一层，它下面挂不了东西。渲染进程本来就不给这个按钮，但
  // node:create 也通过 sync/rpc 暴露给对端，UI 门槛管不到那条路径。
  if (input.parentId) {
    const parent = db
      .select({ kind: schema.knowledgeNode.kind })
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, input.parentId))
      .get();
    if (parent && !canExpandNode(parent.kind)) throw new Error(EXPAND_DEPTH_LIMIT_MESSAGE);
  }

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
