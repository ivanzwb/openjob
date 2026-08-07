import { createRoleClient } from './client';

/** 调用 embedding 角色获取文本向量，失败时返回 null */
export async function embedText(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const { client, model } = createRoleClient('embedding');
    const res = await client.embeddings.create({
      model,
      input: trimmed.slice(0, 8000),
    });
    const vec = res.data[0]?.embedding;
    return vec?.length ? vec : null;
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
