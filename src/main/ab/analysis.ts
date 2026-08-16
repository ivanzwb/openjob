import { getRawDb } from '../db';
import type { LlmRole, LlmTier } from '@shared/enums';

/**
 * Prompt AB 实验分析查询。
 *
 * 读 prompt_run 表做离线回归对比：按 promptId + versionId 聚合
 * 调用次数、成功率、token、延迟、字段完整性。只读，不写任何数据。
 */

export interface VersionAggregate {
  versionId: string;
  runs: number;
  okRuns: number;
  okRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
}

interface RunRow {
  version_id: string;
  ok: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * 按 versionId 聚合某 prompt 的全部调用。
 * 返回每个版本一行；无数据时返回空数组。
 */
export function aggregateByVersion(promptId: string): VersionAggregate[] {
  const raw = getRawDb();
  const rows = raw
    .prepare(
      `SELECT version_id, ok, latency_ms, prompt_tokens, completion_tokens
       FROM prompt_run WHERE prompt_id = ? ORDER BY created_at ASC`,
    )
    .all(promptId) as unknown as RunRow[];

  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const list = groups.get(row.version_id) ?? [];
    list.push(row);
    groups.set(row.version_id, list);
  }

  const out: VersionAggregate[] = [];
  for (const [versionId, list] of groups) {
    const okRuns = list.filter((r) => r.ok === 1).length;
    const latencies = list.map((r) => r.latency_ms).sort((a, b) => a - b);
    out.push({
      versionId,
      runs: list.length,
      okRuns,
      okRate: okRuns / list.length,
      avgLatencyMs: Math.round(list.reduce((s, r) => s + r.latency_ms, 0) / list.length),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      avgPromptTokens: Math.round(
        list.reduce((s, r) => s + (r.prompt_tokens ?? 0), 0) / list.length,
      ),
      avgCompletionTokens: Math.round(
        list.reduce((s, r) => s + (r.completion_tokens ?? 0), 0) / list.length,
      ),
    });
  }
  // 版本号排序：v1 < v2 < v10（按版本号数值，不按字符串）
  out.sort((a, b) => {
    const na = Number(a.versionId.split('@v')[1] ?? 0);
    const nb = Number(b.versionId.split('@v')[1] ?? 0);
    return na - nb;
  });
  return out;
}

/**
 * 字段完整性对比：解析两个版本的成功输出，比较顶层字段集合。
 * 用于判断新版本是否丢失/新增了字段——结构回归比 token 数字更能说明问题。
 */
export function compareFieldCompleteness(
  promptId: string,
  versionA: string,
  versionB: string,
): { onlyInA: string[]; onlyInB: string[]; shared: string[] } {
  const raw = getRawDb();
  const outputs = raw
    .prepare(
      `SELECT version_id, output_json FROM prompt_run
       WHERE prompt_id = ? AND version_id IN (?, ?) AND ok = 1`,
    )
    .all(promptId, versionA, versionB) as unknown as Array<{
    version_id: string;
    output_json: string | null;
  }>;

  const keysOf = (versionId: string): Set<string> => {
    const keys = new Set<string>();
    for (const row of outputs) {
      if (row.version_id !== versionId || !row.output_json) continue;
      try {
        const parsed = JSON.parse(row.output_json) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) keys.add(key);
      } catch {
        // 该行输出不可解析，跳过——完整性问题交给字段集合对比暴露
      }
    }
    return keys;
  };

  const keysA = keysOf(versionA);
  const keysB = keysOf(versionB);
  const onlyInA = [...keysA].filter((k) => !keysB.has(k)).sort();
  const onlyInB = [...keysB].filter((k) => !keysA.has(k)).sort();
  const shared = [...keysA].filter((k) => keysB.has(k)).sort();
  return { onlyInA, onlyInB, shared };
}

/** 某 prompt 最近 N 次原始调用（分析页展示用） */
export function recentRuns(promptId: string, limit = 20): Array<{
  versionId: string;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  createdAt: number;
}> {
  const raw = getRawDb();
  return (
    raw
      .prepare(
        `SELECT version_id, ok, error, latency_ms, created_at FROM prompt_run
         WHERE prompt_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(promptId, limit) as unknown as Array<{
      version_id: string;
      ok: number;
      error: string | null;
      latency_ms: number;
      created_at: number;
    }>
  ).map((r) => ({
    versionId: r.version_id,
    ok: r.ok === 1,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  }));
}

/** 该 prompt 现有多少个版本参与过调用（用于提示「还没有 v2 数据」） */
export function versionsWithRuns(promptId: string): string[] {
  const raw = getRawDb();
  const rows = raw
    .prepare(`SELECT DISTINCT version_id FROM prompt_run WHERE prompt_id = ?`)
    .all(promptId) as unknown as Array<{ version_id: string }>;
  return rows.map((r) => r.version_id);
}

export type { LlmRole, LlmTier };