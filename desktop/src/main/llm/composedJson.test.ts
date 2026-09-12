/**
 * 插件链路的模型入口只接受组合器的产物。
 *
 * 这里盯的不是降档和回退（那些在 json.test.ts），而是「组合结果原样进请求、
 * provenance 原样进 prompt run」这条接缝：断在这里的话，Core Policy 还在
 * prompt 里，但历史结果已经复现不出用的是哪个版本的插件了。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '@core/plugins/legacyRoleData';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import type { ResolvedCapabilityRef } from '@core/plugins/types';
import { composePrompt } from '@core/prompts/composer';
import { CORE_PROMPT_POLICY } from '@core/prompts/grounding';

const mockCreate = vi.fn();
vi.mock('./client', () => ({
  createRoleClient: (...args: unknown[]) => mockCreate(...args),
}));
vi.mock('../ab/experiments', () => ({ getExperiment: () => undefined }));

const recorded: unknown[] = [];
vi.mock('../ab/promptRun', () => ({
  getFingerprint: () => 'test-fingerprint',
  recordPromptRun: (input: unknown) => {
    recorded.push(input);
    return 'run-1';
  },
}));

const { completeComposedJson } = await import('./json');

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

let calls: Array<{ messages: ChatMessage[] }> = [];

const CAPABILITIES: ResolvedCapabilityRef[] = [
  { id: 'source-repository', version: '1.0.0', enabled: true },
];

function composed() {
  return composePrompt({
    runtime: {
      coreVersion: '1.0.0',
      rolePack: { id: 'software-engineering', version: '1.2.0' },
      capabilities: CAPABILITIES,
      configSnapshotHash: 'snapshot-hash',
    },
    rolePack: softwareEngineeringRolePack,
    slot: 'questionGeneration',
    formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
  });
}

beforeEach(() => {
  calls = [];
  recorded.length = 0;
  mockCreate.mockReset();
  mockCreate.mockReturnValue({
    client: {
      chat: {
        completions: {
          create: vi.fn(async (req: Record<string, unknown>) => {
            calls.push(req as never);
            return {
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 0,
              model: 'test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '{"question":"讲讲限流"}' },
                  finish_reason: 'stop',
                  logprobs: null,
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          }),
        },
      },
    },
    model: 'test-model',
    temperature: 0.2,
    tier: 'main',
  });
});

describe('completeComposedJson', () => {
  it('把组合结果原样当 system 发出，Core Policy 仍在最前', async () => {
    const prompt = composed();

    const result = await completeComposedJson<{ question: string }>({
      role: 'quiz',
      prompt,
      user: '考点：限流',
    });

    expect(result).toEqual({ question: '讲讲限流' });
    const system = String(calls[0]!.messages.find((message) => message.role === 'system')!.content);
    expect(system.startsWith(CORE_PROMPT_POLICY)).toBe(true);
    expect(system).toContain(prompt.systemPrompt);
  });

  it('provenance 与 promptId/versionId 一起进 prompt run', async () => {
    const prompt = composed();

    await completeComposedJson({ role: 'quiz', prompt, user: '考点：限流' });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      promptId: prompt.provenance.promptId,
      versionId: prompt.provenance.promptVersionId,
      ok: true,
      provenance: prompt.provenance,
    });
  });

  it('调用失败时也记 provenance——失败同样需要复现', async () => {
    mockCreate.mockReturnValue({
      client: {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error('endpoint down');
            }),
          },
        },
      },
      model: 'test-model',
      temperature: 0.2,
      tier: 'main',
    });
    const prompt = composed();

    await expect(
      completeComposedJson({ role: 'quiz', prompt, user: '考点：限流' }),
    ).rejects.toThrow('模型未返回可用 JSON');

    expect(recorded[0]).toMatchObject({ ok: false, provenance: prompt.provenance });
  });
});
