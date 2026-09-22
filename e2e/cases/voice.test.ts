/**
 * E140–E141 语音输入。
 *
 * 转写要真的加载 STT 模型（`Xenova/whisper-base`，约 73MB）。用例复用**本机已经缓存好的
 * 那一份**：把它搬进隔离副本的 `stt-models/`（transformers.js 先查 `env.cacheDir`，离线可用）。
 * 本机没有缓存就跳过——CI 上不可能现下，这也是这条用例唯一的环境依赖。
 *
 * 断言的是**通路**而不是识别质量：模型能加载、状态会从「缺模型」走到「就绪」、一段采样喂进去
 * 能拿回文本而不是抛错。识别得准不准是模型的事，不是这条用例的事。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type AppInstance } from '../harness/app';
import { copySttModel, makeEnv, type Env } from '../harness/env';

let app: AppInstance;
let env: Env;
let modelReady = false;

beforeAll(async () => {
  env = makeEnv('voice', { plugins: [] });
  modelReady = copySttModel(env);
  app = await launchApp({ userData: env.userData });
}, 300_000);

afterAll(async () => {
  await app?.stop();
});

describe('E140–E141 语音', () => {
  it('E140 状态可读：没加载时报「缺模型」这类明确状态，不抛错', async () => {
    const status = await app.page.invoke<{ state?: string; ready?: boolean }>('stt:status', null);
    expect(status).toBeTruthy();
    expect(typeof status.state === 'string' || typeof status.ready === 'boolean').toBe(true);
  });

  it(
    'E141 转写通路：一份采样喂进去，模型加载完成并拿回文本（不主张识别质量）',
    async (ctx) => {
      // 注意不能用 it.skipIf：它在**收集阶段**求值，那时 beforeAll 还没跑、modelReady 还是初值
      if (!modelReady) ctx.skip();

      // 1 秒静音采样。Float32Array 必须在页面里构造——桥那一层是结构化克隆，
      // 从测试进程用 JSON 传过去只会变成普通对象。
      const result = await app.page.evaluate<{ text: string }>(`(async () => {
        return await window.api.invoke('stt:transcribe', { audio: new Float32Array(16000) });
      })()`);
      expect(typeof result.text).toBe('string');

      // 模型加载之后状态应当是「就绪」——这条同时钉住了「模型确实加载成功」
      await app.page.waitUntil(
        async () => {
          const status = await app.page.invoke<{ state?: string }>('stt:status', null);
          return status.state === 'ready' ? status : '';
        },
        '模型进入就绪态',
        60_000,
      );
    },
    300_000,
  );
});
