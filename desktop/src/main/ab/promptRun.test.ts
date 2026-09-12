/**
 * provenance 必须能从 prompt run 记录复现出来。
 *
 * prompt_run 的列由 T03 独占的迁移决定，插件 provenance 只能落在它旁边的追加
 * 日志里，两边靠 runId 关联。这里盯两件事：写进去能原样读回来（否则历史评分
 * 为什么变了永远说不清），以及日志写不进去时不会把 LLM 调用一起带崩。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptProvenance } from '@core/prompts/composer';

let userData = '';
const insertedRows: unknown[][] = [];

vi.mock('../db', () => ({
  getRawDb: () => ({
    prepare: () => ({
      run: (...args: unknown[]) => {
        insertedRows.push(args);
      },
    }),
  }),
}));
vi.mock('../paths', () => ({
  getAppPaths: () => ({ userData }),
}));
vi.mock('../sync/identity', () => ({
  getDeviceIdentity: () => ({ deviceId: 'device-1' }),
}));

const { readPromptRunProvenance, recordPromptRun } = await import('./promptRun');

const PROVENANCE: PromptProvenance = {
  coreVersion: '1.0.0',
  rolePack: { id: 'software-engineering', version: '1.2.0' },
  capabilityIds: ['source-repository'],
  capabilities: [{ id: 'source-repository', version: '1.0.0' }],
  promptSlot: 'scoring',
  formatId: 'se.technical-knowledge',
  promptId: 'quiz.score',
  promptVersionId: 'quiz.score@v1',
  rubricId: 'se.technical-knowledge-rubric',
  evidenceIds: ['ev-gateway'],
  configSnapshotHash: 'snapshot-hash',
};

function baseInput() {
  return {
    promptId: 'quiz.score',
    versionId: 'quiz.score@v1',
    fingerprint: 'device-1',
    role: 'quiz' as const,
    model: 'test-model',
    tier: 'main' as const,
    ok: true,
    latencyMs: 12,
  };
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'openjob-prompt-run-'));
  insertedRows.length = 0;
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('recordPromptRun', () => {
  it('带 provenance 时按 runId 落一行，可原样读回', () => {
    const runId = recordPromptRun({ ...baseInput(), provenance: PROVENANCE });

    const records = readPromptRunProvenance(runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe(runId);
    expect(records[0]?.promptId).toBe('quiz.score');
    expect(records[0]?.versionId).toBe('quiz.score@v1');
    expect(records[0]?.provenance).toEqual(PROVENANCE);
  });

  it('返回的 runId 与写进 prompt_run 的主键是同一个', () => {
    const runId = recordPromptRun({ ...baseInput(), provenance: PROVENANCE });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.[0]).toBe(runId);
  });

  it('没有 provenance 的调用不写日志——旧调用点行为不变', () => {
    recordPromptRun(baseInput());

    expect(readPromptRunProvenance()).toEqual([]);
  });

  it('多次调用各记一行，互不覆盖', () => {
    const first = recordPromptRun({ ...baseInput(), provenance: PROVENANCE });
    const second = recordPromptRun({
      ...baseInput(),
      ok: false,
      error: '模型未返回可用 JSON',
      provenance: { ...PROVENANCE, promptSlot: 'questionGeneration' },
    });

    expect(readPromptRunProvenance().map((record) => record.runId)).toEqual([first, second]);
    expect(readPromptRunProvenance(second)[0]?.provenance.promptSlot).toBe('questionGeneration');
  });

  it('日志里有损坏行时跳过它，其余记录照样读得出来', () => {
    const runId = recordPromptRun({ ...baseInput(), provenance: PROVENANCE });
    const path = join(userData, 'prompt-run-provenance.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{ 写到一半\n`, 'utf8');

    expect(readPromptRunProvenance().map((record) => record.runId)).toEqual([runId]);
  });

  it('日志目录不可写时不向上抛：打标是旁路', () => {
    userData = join(userData, 'missing', 'deeper');

    expect(() => recordPromptRun({ ...baseInput(), provenance: PROVENANCE })).not.toThrow();
    expect(readPromptRunProvenance()).toEqual([]);
  });
});
