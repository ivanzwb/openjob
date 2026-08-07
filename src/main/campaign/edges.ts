import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { EdgeRelation } from '@shared/enums';
import type { NodeEdgeView } from '@shared/ipc';
import { getDb, schema } from '../db';

export interface EdgeSpec {
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeRelation;
}

function campaignNodeIds(campaignId: string): string[] {
  return getDb()
    .select({ id: schema.knowledgeNode.id })
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all()
    .map((n) => n.id);
}

export function listEdges(campaignId: string): NodeEdgeView[] {
  const db = getDb();
  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();
  if (nodes.length === 0) return [];

  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  return db
    .select()
    .from(schema.nodeEdge)
    .where(inArray(schema.nodeEdge.fromNodeId, [...nameById.keys()]))
    .all()
    .filter((e) => nameById.has(e.toNodeId))
    .map((e) => ({
      id: e.id,
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      fromName: nameById.get(e.fromNodeId) ?? '',
      toName: nameById.get(e.toNodeId) ?? '',
      relation: e.relation,
    }));
}

export function createEdge(spec: EdgeSpec): NodeEdgeView {
  if (spec.fromNodeId === spec.toNodeId) throw new Error('不能连到自己');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.nodeEdge)
    .where(eq(schema.nodeEdge.fromNodeId, spec.fromNodeId))
    .all()
    .find((e) => e.toNodeId === spec.toNodeId && e.relation === spec.relation);
  if (existing) throw new Error('这条关系已存在');

  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(inArray(schema.knowledgeNode.id, [spec.fromNodeId, spec.toNodeId]))
    .all();
  if (nodes.length !== 2) throw new Error('节点不存在');

  const id = randomUUID();
  db.insert(schema.nodeEdge).values({ id, ...spec }).run();

  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  return {
    id,
    ...spec,
    fromName: nameById.get(spec.fromNodeId) ?? '',
    toName: nameById.get(spec.toNodeId) ?? '',
  };
}

export function deleteEdge(id: string): void {
  getDb().delete(schema.nodeEdge).where(eq(schema.nodeEdge.id, id)).run();
}

/**
 * 按节点名建边，供诊断阶段落库 LLM 生成的关系。
 * 名字对不上就跳过——宁可少几条边，也不要连错。
 */
export function insertEdgesByName(
  campaignId: string,
  specs: Array<{ from: string; to: string; relation: EdgeRelation }>,
): number {
  if (specs.length === 0) return 0;
  const db = getDb();
  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();
  if (nodes.length === 0) return 0;
  const idByName = new Map(nodes.map((n) => [n.name.trim().toLowerCase(), n.id]));

  const known = new Set(
    db
      .select()
      .from(schema.nodeEdge)
      .where(inArray(schema.nodeEdge.fromNodeId, campaignNodeIds(campaignId)))
      .all()
      .map((e) => `${e.fromNodeId}|${e.toNodeId}|${e.relation}`),
  );

  let created = 0;
  for (const spec of specs) {
    const fromId = idByName.get(spec.from.trim().toLowerCase());
    const toId = idByName.get(spec.to.trim().toLowerCase());
    if (!fromId || !toId || fromId === toId) continue;

    const key = `${fromId}|${toId}|${spec.relation}`;
    if (known.has(key)) continue;
    known.add(key);

    db.insert(schema.nodeEdge)
      .values({ id: randomUUID(), fromNodeId: fromId, toNodeId: toId, relation: spec.relation })
      .run();
    created++;
  }
  return created;
}

/**
 * 在 prerequisite 约束下重排。输入已按优先级降序，
 * 输出在满足「前置在前」的前提下尽量保持原顺序。
 * 存在环时把剩余节点按原序追加——排程不该因为脏数据整个失败。
 */
export function topoSortByPrerequisite<T extends { id: string }>(
  ordered: T[],
  edges: Array<{ fromNodeId: string; toNodeId: string; relation: EdgeRelation }>,
): T[] {
  const present = new Set(ordered.map((n) => n.id));
  const indegree = new Map<string, number>(ordered.map((n) => [n.id, 0]));
  const dependents = new Map<string, string[]>();

  for (const e of edges) {
    if (e.relation !== 'prerequisite') continue;
    if (!present.has(e.fromNodeId) || !present.has(e.toNodeId)) continue;
    indegree.set(e.toNodeId, (indegree.get(e.toNodeId) ?? 0) + 1);
    const list = dependents.get(e.fromNodeId) ?? [];
    list.push(e.toNodeId);
    dependents.set(e.fromNodeId, list);
  }

  const byId = new Map(ordered.map((n) => [n.id, n]));
  const out: T[] = [];
  const emitted = new Set<string>();

  // 每轮取出当前入度为 0 且优先级最高的节点，保证原有排序在约束下最大程度保留
  while (out.length < ordered.length) {
    const next = ordered.find((n) => !emitted.has(n.id) && (indegree.get(n.id) ?? 0) === 0);
    if (!next) break;

    out.push(next);
    emitted.add(next.id);
    for (const dep of dependents.get(next.id) ?? []) {
      indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
    }
  }

  for (const n of ordered) {
    if (!emitted.has(n.id)) out.push(byId.get(n.id)!);
  }
  return out;
}
