import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { cosineSimilarity, embedText } from '../llm/embedding';
import { findDuplicateByName, normalizeName } from './tree';

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

/** 名称 + embedding 双重去重，返回应跳过的子考点名 */
export async function filterDuplicatesByEmbedding(
  campaignId: string,
  candidates: string[],
): Promise<string[]> {
  const db = getDb();
  const siblings = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  const existingNames = siblings.map((n) => n.name);
  const existingEmbeddings: Array<{ name: string; vec: number[] }> = [];
  for (const s of siblings) {
    if (s.embedding?.length) {
      existingEmbeddings.push({ name: s.name, vec: s.embedding });
    }
  }

  const skipped: string[] = [];

  for (const name of candidates) {
    if (findDuplicateByName(existingNames, name)) {
      skipped.push(name);
      continue;
    }

    const vec = await embedText(name);
    if (!vec) continue;

    let duplicate = false;
    for (const ex of existingEmbeddings) {
      if (cosineSimilarity(vec, ex.vec) >= SIMILARITY_THRESHOLD) {
        duplicate = true;
        skipped.push(name);
        break;
      }
    }
    if (!duplicate) {
      existingEmbeddings.push({ name, vec });
      existingNames.push(name);
    }
  }

  return skipped;
}

export function isNearDuplicateName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
