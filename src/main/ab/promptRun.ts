import { randomUUID } from 'node:crypto';
import { getRawDb } from '../db';
import { getDeviceIdentity } from '../sync/identity';
import type { LlmRole, LlmTier } from '@shared/enums';

/**
 * 每次 completeJson 调用的落库记录（桌面端）。
 *
 * 原则：打标是旁路。写库失败（表缺失、DB 未就绪）绝不向上抛——实验数据
 * 丢了可以重跑，LLM 调用不能因为打标而失败。
 */

export interface PromptRunInput {
  promptId: string;
  versionId: string;
  /** 分流指纹：设备 id 等稳定标识 */
  fingerprint: string;
  role: LlmRole;
  model: string;
  tier: LlmTier;
  ok: boolean;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  /** 原始输出，截断存——离线回归只需字段完整性，不需要完整正文 */
  outputJson?: string;
}

/** 单条输出上限：分析只关心结构，超长正文截掉避免撑爆库 */
const MAX_OUTPUT_JSON = 50_000;

/**
 * 打标失败绝不能影响主流程：实验数据是分析原料，丢了可重跑，
 * LLM 调用不能因为打标而失败。所以这里吞掉一切异常。
 */
export function recordPromptRun(input: PromptRunInput): void {
  try {
    const raw = getRawDb();
    raw
      .prepare(
        `INSERT INTO prompt_run (
           id, prompt_id, version_id, fingerprint, role, model, tier,
           ok, error, prompt_tokens, completion_tokens, latency_ms, output_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.promptId,
        input.versionId,
        input.fingerprint,
        input.role,
        input.model,
        input.tier,
        input.ok ? 1 : 0,
        input.error ?? null,
        input.promptTokens ?? 0,
        input.completionTokens ?? 0,
        input.latencyMs,
        input.outputJson ? input.outputJson.slice(0, MAX_OUTPUT_JSON) : null,
        Date.now(),
      );
  } catch {
    // 打标是旁路：写不进去不阻断主流程
  }
}

/** 稳定分流指纹：设备 id（sync_meta 里持久化的那个）。拿不到时返回 undefined（即不参与实验）。 */
export function getFingerprint(): string | undefined {
  try {
    return getDeviceIdentity(getRawDb()).deviceId;
  } catch {
    return undefined;
  }
}