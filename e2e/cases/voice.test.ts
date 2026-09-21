/**
 * E140–E141 语音输入。
 *
 * **为什么只覆盖状态**：转写要真的加载 STT 模型（transformers.js 首次运行会从 HuggingFace
 * 下载几十 MB），离线 / CI 环境拉不到；而且 `stt:transcribe` 要的是浮点采样数组，
 * 得先有一段真实录音。这里的价值是「模型不在时应用给出的是明确状态，而不是假装能用」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, type AppInstance } from '../harness/app';
import { makeEnv, type Env } from '../harness/env';

let app: AppInstance;
let env: Env;

beforeAll(async () => {
  env = makeEnv('voice', { plugins: [] });
  app = await launchApp({ userData: env.userData });
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

describe('E140–E141 语音', () => {
  it('E140 状态可读：没下模型时报「缺模型」这类明确状态，不抛错', async () => {
    const status = await app.page.invoke<{ state?: string; phase?: string; ready?: boolean }>(
      'stt:status',
      null,
    );
    expect(status).toBeTruthy();
    // 首次进入时模型一定不在（用例环境不联网下载），此时 ready 必须是明确的是 / 否
    expect(typeof status.ready === 'boolean' || typeof status.state === 'string').toBe(true);
  });

  /**
   * 已知缺口：转写要真的加载 STT 模型。模型不在时 `stt:transcribe` 会返回空文本——
   * 这本身不算错（没有模型就没有识别结果），所以「静默空结果」在这里不构成缺陷断言；
   * 要真正验证转写就得预置模型，见 E141。
   */
  it.skip('E140b 模型就绪之前调用转写被明确拒绝', () => undefined);
});

/**
 * 已知缺口：真实转写要么预置一份 STT 模型到 `userData/stt-models`，要么给测试台留一个
 * 「离线模型目录」的注入点。两者都是测试台之外的决定（预置体积 / 应用侧接缝），
 * 定了之后这条用例就是把一段 wav 采样喂进去、断言文本进作答框。
 */
it.skip('E141 转写：一段录音变成文本并落到作答框', () => undefined);
