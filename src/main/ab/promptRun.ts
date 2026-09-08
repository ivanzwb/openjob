import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRawDb } from '../db';
import { getAppPaths } from '../paths';
import { getDeviceIdentity } from '../sync/identity';
import type { LlmRole, LlmTier } from '@shared/enums';
import type { PromptProvenance } from '@shared/prompts/composer';

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
  /** 走 Core Prompt 组合器时本次用到的插件版本，用于复现 */
  provenance?: PromptProvenance;
}

/** 单条输出上限：分析只关心结构，超长正文截掉避免撑爆库 */
const MAX_OUTPUT_JSON = 50_000;

/**
 * provenance 写在 prompt_run 旁边的追加日志里，而不是 prompt_run 的新列。
 *
 * 迁移编号由 T03 独占分配，插件 provenance 又必须和它描述的那次调用绑在一起，
 * 所以这里按 prompt_run.id 逐行追加：两边靠 runId 关联，读回来就能复现当时的
 * Core 版本、岗位包版本和能力插件版本。日志和打标一样是旁路，写不进去不阻断。
 */
const PROVENANCE_LOG_FILE = 'prompt-run-provenance.jsonl';

/** 超过这个大小就滚动成 .1，只保留一代——复现看的是最近的调用 */
const PROVENANCE_LOG_MAX_BYTES = 4_000_000;

export interface PromptRunProvenanceRecord {
  runId: string;
  promptId: string;
  versionId: string;
  createdAt: number;
  provenance: PromptProvenance;
}

function provenanceLogPath(): string {
  return join(getAppPaths().userData, PROVENANCE_LOG_FILE);
}

function rotateProvenanceLog(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size < PROVENANCE_LOG_MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}

function appendProvenance(record: PromptRunProvenanceRecord): void {
  try {
    const path = provenanceLogPath();
    rotateProvenanceLog(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // provenance 日志是旁路：写不进去不阻断主流程
  }
}

/**
 * 打标失败绝不能影响主流程：实验数据是分析原料，丢了可重跑，
 * LLM 调用不能因为打标而失败。所以这里吞掉一切异常。
 *
 * 返回 prompt_run 行 id：provenance 日志靠它和这一行对上。
 */
export function recordPromptRun(input: PromptRunInput): string {
  const id = randomUUID();
  const createdAt = Date.now();
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
        id,
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
        createdAt,
      );
  } catch {
    // 打标是旁路：写不进去不阻断主流程
  }

  if (input.provenance) {
    appendProvenance({
      runId: id,
      promptId: input.promptId,
      versionId: input.versionId,
      createdAt,
      provenance: input.provenance,
    });
  }
  return id;
}

/** 读回 provenance。runId 省略时返回全部记录（最早在前）。 */
export function readPromptRunProvenance(runId?: string): PromptRunProvenanceRecord[] {
  let text: string;
  try {
    const path = provenanceLogPath();
    if (!existsSync(path)) return [];
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records: PromptRunProvenanceRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as PromptRunProvenanceRecord;
      if (runId === undefined || record.runId === runId) records.push(record);
    } catch {
      // 单行损坏（写入被中断）时跳过，不影响其余记录
    }
  }
  return records;
}

/** 稳定分流指纹：设备 id（sync_meta 里持久化的那个）。拿不到时返回 undefined（即不参与实验）。 */
export function getFingerprint(): string | undefined {
  try {
    return getDeviceIdentity(getRawDb()).deviceId;
  } catch {
    return undefined;
  }
}
