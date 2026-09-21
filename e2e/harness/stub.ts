/**
 * 本地桩服务器：冒充模型 Provider 与检索 Provider。
 *
 * 隔离副本的 `config.json` 把 baseUrl / endpoint 指到这里，应用的调用路径一行都不用改，
 * AI 路径因此变成确定性的——出题、评分、讲解、检索都有固定返回，还能注入失败。
 *
 * 分派靠**扫 prompt 里声明的 JSON 字段名**：每个 prompt 都会把自己要的结构写出来
 * （`"scenarioMd"`、`"dimensions"`、`"repoMap"`…），按这个选返回体就不用维护一张
 * «promptId → 响应» 的表，也不会因为片段改字而失效。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  path: string;
  body: unknown;
  /** system 正文 + user 正文拼起来的全文，用来断言「prompt 里带了什么」 */
  text: string;
  at: number;
}

export interface StubFailure {
  /** 命中判据（文本包含） */
  when: string;
  kind: 'http-500' | 'hang' | 'truncated-json';
}

export class LlmStub {
  private server: Server | null = null;
  private port = 0;
  readonly requests: StubRequest[] = [];
  readonly failures: StubFailure[] = [];
  /** 固定的评分引文来源：真正的作答文本由用例填进来，桩从这里挑一句当 answerQuote */
  answerMd = '';
  /** 让评分返回一段作答里并不存在的引文，用于验证「引文对不上要打回」 */
  ungroundedQuote = false;
  private persistent: StubFailure | null = null;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get searchEndpoint(): string {
    return `http://127.0.0.1:${this.port}/search`;
  }

  failNext(when: string, kind: StubFailure['kind']): void {
    this.failures.push({ when, kind });
  }

  /**
   * 一直失败直到 clearFailure()。
   *
   * 单次注入对模型调用不够用：SDK 自带重试（maxRetries 2），第一次注入会被重试吃掉，
   * 用例看到的是「居然成功了」。要断言错误路径就得让每种尝试都失败。
   */
  alwaysFail(when: string, kind: StubFailure['kind']): void {
    this.persistent = { when, kind };
  }

  clearFailure(): void {
    this.persistent = null;
  }

  clear(): void {
    this.requests.length = 0;
    this.failures.length = 0;
  }

  /** 某个通道被请求过几次，以及最后一次的全文 */
  calls(marker: string): StubRequest[] {
    return this.requests.filter((r) => r.text.includes(marker));
  }

  lastText(marker: string): string {
    return this.calls(marker).at(-1)?.text ?? '';
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const text = collectText(body);
    this.requests.push({ path: req.url ?? '', body, text, at: Date.now() });

    const failure =
      this.failures.find((f) => text.includes(f.when)) ??
      (this.persistent && text.includes(this.persistent.when) ? this.persistent : undefined);
    if (failure) {
      const index = this.failures.indexOf(failure);
      if (index >= 0) this.failures.splice(index, 1);
      if (failure.kind === 'http-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub: 注入的 500' } }));
        return;
      }
      if (failure.kind === 'hang') return; // 不响应，让用例撞超时
      return this.sendCompletion(res, '{"title": "被截断', true);
    }

    if ((req.url ?? '').includes('/search')) return this.sendSearch(res);
    return this.sendCompletion(
      res,
      JSON.stringify(pickResponse(text, this.answerMd, this.ungroundedQuote)),
      false,
    );
  }

  private sendSearch(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 200,
        data: {
          webPages: {
            value: [
              {
                name: '某公司后端面试面经（2026 校招）',
                url: 'https://example.com/interview/backend-2026',
                snippet: '一面问了 JVM 内存模型与 G1 调优，二面是系统设计：设计一个短链服务。',
                summary: '该公司后端面试重原理与系统设计，八股集中在 JVM / 并发 / MySQL。',
                siteName: 'example.com',
                datePublished: '2026-03-01',
              },
              {
                name: '短链服务设计要点',
                url: 'https://docs.example.dev/short-url',
                snippet: '发号器、缓存、跳转链路与统计。',
                summary: '短链服务的常见考点。',
                siteName: 'docs.example.dev',
                datePublished: '2025-11-02',
              },
            ],
          },
        },
      }),
    );
  }

  private sendCompletion(res: ServerResponse, content: string, truncated: boolean): void {
    res.writeHead(truncated ? 200 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'stub-cmpl',
        object: 'chat.completion',
        model: 'e2e-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: truncated ? 'length' : 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

/** 请求体里所有 role=system/user 的文本，拼成一份便于断言与分派的全文 */
function collectText(body: unknown): string {
  const messages = (body as { messages?: Array<{ content?: unknown }> } | null)?.messages;
  if (!Array.isArray(messages)) return typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n');
}

/**
 * 按 prompt 里声明的字段名选一个返回体。
 *
 * 顺序有讲究：评分那一段同时提到 dimensions 与题干，先认 dimensions；出题认 scenarioMd；
 * 其余按各自唯一的字段名认。
 */
export function pickResponse(
  text: string,
  answerMd: string,
  ungrounded = false,
): Record<string, unknown> {
  if (text.includes('"dimensions"')) return scoringResponse(text, answerMd, ungrounded);
  if (text.includes('"scenarioMd"')) {
    return {
      title: 'E2E 短标题',
      scenarioMd: '请做一个简短的自我介绍，控制在 60-90 秒，并说明你与岗位的匹配点。',
    };
  }
  if (text.includes('"repoMap"')) {
    return {
      summary: 'E2E 桩：一个用于测试的仓库摘要。',
      repoMap: 'src/index.ts — main(fn)：入口',
    };
  }
  if (text.includes('"answerMd"')) {
    return { answerMd: 'E2E 桩：这是参考答案正文。' };
  }
  if (text.includes('"feedbackMd"')) {
    return {
      feedbackMd: 'E2E 桩：逐点反馈。',
      improvedOutlineMd: 'E2E 桩：改进后的答题稿。',
      improvedScriptMd: 'E2E 桩：改进后的答题稿。',
      score: 4,
    };
  }
  if (text.includes('"sections"')) {
    return {
      sections: [
        { key: 'basic', contentMd: '姓名：E2E\n城市：杭州' },
        { key: 'summary', contentMd: 'E2E 桩：个人总结。' },
      ],
    };
  }
  if (text.includes('"contentMd"')) return { contentMd: 'E2E 桩：润色后的正文。' };
  if (text.includes('"answerQuote"')) return { feedbackMd: 'E2E 桩：反馈。' };
  if (text.includes('"reply"')) return { reply: 'E2E 桩：客户回应——那你们的价格比现在高多少？' };
  if (text.includes('"markdown"')) return { markdown: '## E2E 桩讲解\n\n这是讲解正文。' };
  if (text.includes('"questions"')) {
    return {
      questions: [
        { text: 'JVM 内存模型是怎么划分的？', nodeName: '内存模型', kind: 'knowledge' },
        { text: '设计一个短链服务。', nodeName: '一致性', kind: 'design' },
      ],
    };
  }
  if (text.includes('"question"')) {
    return {
      question: 'E2E 桩题目：请解释 JVM 内存模型的划分与可见性规则。',
      answer: 'E2E 桩参考答案。',
      keyPoints: ['JMM', 'happens-before'],
    };
  }
  if (text.includes('"nodes"')) {
    // 诊断：jdParsed + 两层知识点树（domain → topic）+ 横向关系
    return {
      jdParsed: {
        roleTitle: '资深后端开发工程师',
        requirements: [
          { skill: 'Java 与 JVM', weight: 0.5 },
          { skill: '分布式系统设计', weight: 0.5 },
        ],
        seniority: 'senior',
      },
      nodes: [
        {
          name: 'JVM',
          kind: 'domain',
          examProb: 0.8,
          difficulty: 3,
          estMinutes: 60,
          examForms: ['concept'],
          coverageType: 'gap',
          children: [
            {
              name: '内存模型',
              kind: 'topic',
              examProb: 0.8,
              difficulty: 4,
              estMinutes: 30,
              examForms: ['concept'],
              coverageType: 'gap',
            },
            {
              name: '垃圾回收',
              kind: 'topic',
              examProb: 0.6,
              difficulty: 3,
              estMinutes: 30,
              examForms: ['concept'],
              coverageType: 'gap',
            },
          ],
        },
        {
          name: '分布式系统',
          kind: 'domain',
          examProb: 0.7,
          difficulty: 5,
          estMinutes: 90,
          examForms: ['design'],
          coverageType: 'gap',
          children: [
            {
              name: '一致性',
              kind: 'topic',
              examProb: 0.7,
              difficulty: 5,
              estMinutes: 45,
              examForms: ['design'],
              coverageType: 'gap',
            },
          ],
        },
      ],
      edges: [{ from: 'JVM', to: '内存模型', relation: 'prerequisite' }],
    };
  }
  if (text.includes('"tasks"')) {
    return {
      days: [
        {
          date: new Date().toISOString().slice(0, 10),
          tasks: [
            { title: 'E2E 桩任务', kind: 'learn', estMinutes: 30, nodeName: 'JVM 内存模型' },
          ],
        },
      ],
    };
  }
  return { ok: true };
}

/** 评分：从 prompt 里读出维度 id，并给一段真实存在于作答里的引文，好让引文校验通过 */
function scoringResponse(
  text: string,
  answerMd: string,
  ungrounded: boolean,
): Record<string, unknown> {
  const ids = /一条不能少：([^；]+)；/.exec(text)?.[1]?.split('、').map((s) => s.trim()) ?? [];
  const quote = ungrounded ? 'E2E 桩：一段作答里根本没有的引文' : quoteFromAnswer(text, answerMd);
  return {
    feedbackMd: 'E2E 桩：整体不错，结构清楚。',
    improvedOutlineMd: 'E2E 桩：改进稿大纲。',
    dimensions: (ids.length > 0 ? ids : ['e2e.dimension']).map((dimensionId, index) => ({
      dimensionId,
      score: index === 0 ? 3 : 4,
      answerQuote: quote,
      rationale: 'E2E 桩：落在这一档的理由。',
    })),
  };
}

/**
 * 引文必须逐字出现在「提交评分的作答」里，否则 groundDimensionScores 会把它判成
 * ungrounded，用例就会看到「评分没有通过校验」。
 *
 * 只截到第一个句号 / 换行，**不动中间的空白**：作答里「研发 17 年」的空格也得原样留着，
 * 去掉了就不再是连续子串。
 */
function quoteFromAnswer(text: string, fallback: string): string {
  const marker = '提交评分的作答：';
  const raw = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : fallback;
  const firstLine = raw.replace(/^\s+/, '').split('\n')[0] ?? '';
  const cut = firstLine.split(/[。！？；]/)[0] ?? firstLine;
  return cut.trim().slice(0, 60);
}
