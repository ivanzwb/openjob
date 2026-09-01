/**
 * 手机端 completeJson 的回退链防线。
 *
 * 这份实现和桌面的 src/main/llm/json.ts 是两份平行代码（一份走 OpenAI SDK，
 * 一份直接 fetch），共用的只有 prompt 和 @shared/llm/parseJson。桌面那边有
 * json.test.ts 守着，手机这份长期没有——而「提交评分」踩到的截断就出在这条路上，
 * 所以两端都得各守各的。
 *
 * 重点守两件事：解析失败要能继续用剩下的 attempt 配置重试（以前解析在整个循环
 * 之外，第一次拿到脏输出就直接抛，备好的回退一次都用不上），以及截断要报得
 * 让人看得懂、能定位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./resolve', () => ({
  resolveLlmRole: async () => ({
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    apiKey: 'test-key',
    temperature: 0.2,
  }),
}));

const { completeJson } = await import('./json');

interface RequestBody {
  max_tokens: number;
  response_format?: { type: string };
  messages: { role: string; content: string }[];
}

let bodies: RequestBody[] = [];

/** 每次 fetch 依次返回一个 choice；handler 拿到的是第几次调用 */
function mockLlm(handler: (attempt: number) => { content?: string; finishReason?: string }) {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as RequestBody);
      const { content, finishReason } = handler(bodies.length - 1);
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: content ?? null }, finish_reason: finishReason ?? 'stop' },
          ],
        }),
      };
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  bodies = [];
});

describe('正常路径', () => {
  it('端点返回合法 JSON -> 解析并返回，只打一次', async () => {
    mockLlm(() => ({ content: '{"ok":true}' }));
    await expect(completeJson('outline', 'quiz.question', 'user')).resolves.toEqual({ ok: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.response_format).toEqual({ type: 'json_object' });
    expect(bodies[0]?.max_tokens).toBe(16384);
  });

  it('带 markdown 围栏 -> 剥掉再解析', async () => {
    mockLlm(() => ({ content: '```json\n{"ok":1}\n```' }));
    await expect(completeJson('outline', 'quiz.question', 'user')).resolves.toEqual({ ok: 1 });
  });
});

describe('解析失败后的回退', () => {
  it('第一次返回不可解析的正文 -> 换下一套 attempt 配置重试', async () => {
    mockLlm((attempt) => ({ content: attempt === 0 ? '这不是 JSON' : '{"ok":true}' }));
    await expect(completeJson('outline', 'quiz.question', 'user')).resolves.toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    // 换的是配置而不是原样重发：第二次去掉了 response_format
    expect(bodies[1]?.response_format).toBeUndefined();
  });

  it('每套配置只试一次 -> 不在同一套配置上空转', async () => {
    mockLlm(() => ({ content: '这不是 JSON' }));
    await expect(completeJson('outline', 'quiz.question', 'user')).rejects.toThrow();
    expect(bodies).toHaveLength(4);
  });
});

describe('截断', () => {
  const truncated = '{"score":4,"feedbackMd":"结构清晰","improvedScriptMd":"我会从三个层面讲';

  it('评分类 prompt -> 补全收口，已写完的字段保住', async () => {
    mockLlm(() => ({ content: truncated, finishReason: 'length' }));
    const result = await completeJson<{ score: number; improvedScriptMd: string }>(
      'quiz',
      'quiz.score',
      'user',
    );
    expect(result.score).toBe(4);
    expect(result.improvedScriptMd).toBe('我会从三个层面讲');
    expect(bodies).toHaveLength(1);
  });

  it('不在抢救名单里 -> 报错而不是静默返回残缺数据', async () => {
    mockLlm(() => ({ content: truncated, finishReason: 'length' }));
    await expect(completeJson('outline', 'quiz.question', 'user')).rejects.toThrow('模型输出被截断');
  });

  it('报错带上字符数和 finish_reason，能判断是不是撞了输出上限', async () => {
    // 用户看到的原来只有一句 JSON Parse error: Unexpected end of input
    mockLlm(() => ({ content: truncated, finishReason: 'length' }));
    await expect(completeJson('outline', 'quiz.question', 'user')).rejects.toThrow(
      /收到 \d+ 字符，finish_reason=length/,
    );
  });
});

describe('空正文兜底', () => {
  it('正文为空但有 reasoning_content -> 用思考过程兜底', async () => {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as RequestBody);
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: { content: '', reasoning_content: '{"ok":"reasoned"}' },
                finish_reason: 'length',
              },
            ],
          }),
        };
      }),
    );
    await expect(completeJson('outline', 'quiz.question', 'user')).resolves.toEqual({
      ok: 'reasoned',
    });
  });
});
