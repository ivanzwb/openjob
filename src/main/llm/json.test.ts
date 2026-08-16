/**
 * completeJson 降档与兜底逻辑的回归防线。
 *
 * 这段逻辑保证：任何 OpenAI 兼容端点都能返回结构化 JSON——
 * 撞 token 上限就降、不支持 json_object 就去掉、不支持 system 就折叠、
 * 只给思考过程就兜底用。重构后跑这里，确认这些回退链没被改断。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';

// 先 mock，再 import 被测模块：completeJson 里的 createRoleClient 走 mock
const mockCreate = vi.fn();
vi.mock('./client', () => ({
  createRoleClient: (...args: unknown[]) => mockCreate(...args),
}));

// AB 打标与实验开关依赖 electron/db，Node 测试环境不可用，整体 mock 掉
vi.mock('../ab/experiments', () => ({
  getExperiment: () => undefined,
}));
vi.mock('../ab/promptRun', () => ({
  getFingerprint: () => 'test-fingerprint',
  recordPromptRun: () => {},
}));

const { completeJson } = await import('./json');

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ResponseMessage = OpenAI.Chat.Completions.ChatCompletionMessage;

function responseMessage(partial: Partial<ResponseMessage>): ResponseMessage {
  return {
    role: 'assistant',
    content: null,
    ...partial,
  } as ResponseMessage;
}

function completion(messages: ResponseMessage[]): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: messages.map((message, i) => ({
      index: i,
      message,
      finish_reason: 'stop',
      logprobs: null,
    })),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** 记录 create() 每次收到的参数 */
let calls: Array<{ messages: ChatMessage[]; max_tokens: number; response_format?: unknown }> = [];

/** 构造 createRoleClient 的返回：shape 必须与真实实现一致（{ client, model, temperature, tier }） */
function roleClient(createImpl: (req: Record<string, unknown>) => Promise<unknown> | unknown) {
  return {
    client: {
      chat: {
        completions: {
          create: vi.fn(async (req: Record<string, unknown>) => createImpl(req)),
        },
      },
    },
    model: 'test-model',
    temperature: 0.2,
    tier: 'main',
  };
}

function setupClient(handler: (call: typeof calls[number], attempt: number) => Promise<unknown> | unknown) {
  mockCreate.mockReturnValue(
    roleClient((req) => {
      calls.push(req as never);
      return handler(req as never, calls.length - 1);
    }),
  );
  calls = [];
}

function recordCalls() {
  mockCreate.mockReturnValue(
    roleClient((req) => {
      calls.push(req as never);
      throw new Error('unexpected');
    }),
  );
  calls = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  mockCreate.mockReset();
});

describe('completeJson 正常路径', () => {
  it('端点返回合法 JSON -> 解析并返回', async () => {
    setupClient(() => completion([responseMessage({ content: '{"ok":true}' })]));
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: true });
    // 默认打开 json_object 格式
    expect(calls[0]?.response_format).toEqual({ type: 'json_object' });
  });

  it('返回带 markdown 围栏的 JSON -> 剥掉围栏再解析', async () => {
    setupClient(() => completion([responseMessage({ content: '```json\n{"ok":1}\n```' })]));
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: 1 });
  });
});

describe('completeJson token 降档', () => {
  it('端点 400 max_tokens 上限 -> 按报错里的上限降档重试', async () => {
    let attempt = 0;
    setupClient(() => {
      attempt++;
      if (attempt === 1) {
        throw new Error('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]');
      }
      return completion([responseMessage({ content: '{"ok":true}' })]);
    });
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: true });
    // 第一次 16384，报错后降到 8192
    expect(calls[0]?.max_tokens).toBe(16384);
    expect(calls[1]?.max_tokens).toBe(8192);
  });

  it('报错只说上限不说范围 -> 对折重试', async () => {
    let attempt = 0;
    setupClient(() => {
      attempt++;
      if (attempt === 1) throw new Error('max_tokens must be <= 4096');
      return completion([responseMessage({ content: '{"ok":true}' })]);
    });
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: true });
    expect(calls[1]?.max_tokens).toBe(8192); // 16384 / 2
  });

  it('降档撞到下限 -> 放弃重试并报错', async () => {
    recordCalls();
    mockCreate.mockReturnValue(
      roleClient((req) => {
        calls.push(req as never);
        throw new Error('max_tokens must be <= 1024'); // 16384 -> 8192 -> 4096 -> 2048 后停
      }),
    );
    await expect(completeJson('outline', 'quiz.question', 'user')).rejects.toThrow('模型未返回可用 JSON');
    // 前四次按对折降档：16384 -> 8192 -> 4096 -> 2048
    expect(calls.slice(0, 4).map((c) => c.max_tokens)).toEqual([16384, 8192, 4096, 2048]);
    // 撞到下限后不再降，剩余尝试都停在 2048
    expect(calls.slice(4).every((c) => c.max_tokens === 2048)).toBe(true);
    // 全程没有一个请求低于下限
    expect(Math.min(...calls.map((c) => c.max_tokens))).toBe(2048);
  });
});

describe('completeJson 空正文与推理兜底', () => {
  it('正文为空但有 reasoning_content -> 用思考过程当末位兜底', async () => {
    setupClient(() =>
      completion([
        responseMessage({
          content: '',
          finish_reason: 'length',
          reasoning_content: '{"ok":"reasoned"}',
        } as never),
      ]),
    );
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: 'reasoned' });
  });

  it('正文与思考都为空 -> 报错', async () => {
    recordCalls();
    mockCreate.mockReturnValue(
      roleClient(() =>
        completion([
          responseMessage({
            content: null,
            finish_reason: 'stop',
          } as never),
        ]),
      ),
    );
    await expect(completeJson('outline', 'quiz.question', 'user')).rejects.toThrow('模型未返回可用 JSON');
  });
});

describe('completeJson 端点能力回退', () => {
  it('不支持 json_object -> 去掉 response_format 重试', async () => {
    let attempt = 0;
    setupClient(() => {
      attempt++;
      if (attempt === 1) throw new Error('response_format json_object is not supported');
      return completion([responseMessage({ content: '{"ok":true}' })]);
    });
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.response_format).toEqual({ type: 'json_object' });
    expect(calls[1]?.response_format).toBeUndefined();
  });

  it('不支持 system 角色 -> 折叠进 user 后重试', async () => {
    let attempt = 0;
    setupClient(() => {
      attempt++;
      // 前两次 attempt（非折叠 + json / 非折叠 + 无json）都抛 system 错误，
      // 第三次 attempt 才是折叠后的消息
      if (attempt <= 2) throw new Error('system message must be at the beginning');
      return completion([responseMessage({ content: '{"ok":true}' })]);
    });
    const result = await completeJson('outline', 'quiz.question', 'user');
    expect(result).toEqual({ ok: true });
    // 前两次尝试是折叠前的原始消息（含 system）
    expect(calls[0]!.messages.some((m) => m.role === 'system')).toBe(true);
    expect(calls[1]!.messages.some((m) => m.role === 'system')).toBe(true);
    // 成功的那次是折叠后的消息：无 system，指令折叠进首条 user
    const successful = calls.at(-1)!;
    expect(successful.messages.every((m) => m.role !== 'system')).toBe(true);
    expect(
      successful.messages.some((m) => m.role === 'user' && String(m.content).includes('你是面试官')),
    ).toBe(true);
  });
});