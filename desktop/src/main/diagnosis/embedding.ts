import { eq } from 'drizzle-orm';
import type { NodeKind } from '@core/enums';
import { findCrossLevelDuplicate, findSameLevelDuplicate, normalizeName } from '@core/diagnosis/tree';
import { getDb, schema } from '../db';
import { cosineSimilarity, embedText } from '../llm/embedding';

const SIMILARITY_THRESHOLD = 0.88;

export async function ensureNodeEmbedding(nodeId: string, name: string): Promise<number[] | null> {
  const db = getDb();
  const row = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.id, nodeId))
    .get();
  if (!row) return null;
  if (row.embedding?.length) return row.embedding;

  const vec = await embedText(name);
  if (!vec) return null;

  db.update(schema.knowledgeNode)
    .set({ embedding: vec })
    .where(eq(schema.knowledgeNode.id, nodeId))
    .run();
  return vec;
}

/**
 * 名称 + embedding 双重去重，返回应跳过的候选考点名。
 *
 * 只有同一层级（同 kind）的已有考点参与语义比对。跨层的父子命名共享前缀，向量也高度
 * 相似，一起比会把「索引」下面的「索引下推」整批判成重复——细化就永远加不出新考点。
 */
export async function filterDuplicatesByEmbedding(
  campaignId: string,
  candidates: string[],
  sameLevelKind: NodeKind,
): Promise<string[]> {
  const db = getDb();
  const nodes = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  const sameLevel = nodes.filter((n) => n.kind === sameLevelKind);
  const crossLevelNames = nodes.filter((n) => n.kind !== sameLevelKind).map((n) => n.name);

  const sameLevelNames = sameLevel.map((n) => n.name);
  const sameLevelEmbeddings: Array<{ name: string; vec: number[] }> = [];
  for (const node of sameLevel) {
    if (node.embedding?.length) {
      sameLevelEmbeddings.push({ name: node.name, vec: node.embedding });
    }
  }

  const skipped: string[] = [];

  for (const name of candidates) {
    if (
      findSameLevelDuplicate(sameLevelNames, name) ||
      findCrossLevelDuplicate(crossLevelNames, name)
    ) {
      skipped.push(name);
      continue;
    }

    const vec = await embedText(name);
    if (!vec) continue;

    let duplicate = false;
    for (const ex of sameLevelEmbeddings) {
      if (cosineSimilarity(vec, ex.vec) >= SIMILARITY_THRESHOLD) {
        duplicate = true;
        skipped.push(name);
        break;
      }
    }
    if (!duplicate) {
      sameLevelEmbeddings.push({ name, vec });
      sameLevelNames.push(name);
    }
  }

  return skipped;
}

export function isNearDuplicateName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
