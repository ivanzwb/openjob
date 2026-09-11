import { describe, expect, it } from 'vitest';
import {
  buildRepoSynthesisMessages,
  looksLikeToolProtocol,
  shouldRetryRepoSynthesis,
} from './repoAnswerPolicy';

describe('looksLikeToolProtocol', () => {
  it('识别模型泄漏出来的 XML 工具调用', () => {
    expect(
      looksLikeToolProtocol(`
<tool_call>
<function=grep>
<parameter=path>repo</parameter>
<parameter=pattern>concludesTurn</parameter>
</function>
</tool_call>`),
    ).toBe(true);
  });

  it('识别连续多个工具调用', () => {
    expect(
      looksLikeToolProtocol(
        '<tool_call><function=glob><parameter=pattern>agent.ts</parameter></function></tool_call>' +
          '<tool_call><function=grep><parameter=pattern>loop</parameter></function></tool_call>',
      ),
    ).toBe(true);
  });

  it('正常源码分析不会因为提到 tool_call 一词被误伤', () => {
    expect(
      looksLikeToolProtocol(
        '循环会读取响应里的 `tool_calls`，逐个执行后把结果作为 tool message 加回上下文。' +
          '然后模型进入下一轮，直到没有新的调用为止。',
      ),
    ).toBe(false);
  });

  it('带 Mermaid 的最终回答不是工具协议', () => {
    expect(
      looksLikeToolProtocol('结论：这是标准 ReAct 循环。\n```mermaid\nflowchart TD\nA-->B\n```'),
    ).toBe(false);
  });

  it('空内容不是协议泄漏', () => {
    expect(looksLikeToolProtocol('')).toBe(false);
  });
});

describe('buildRepoSynthesisMessages', () => {
  it('最终上下文只有问题和已读源码，不携带工具调用轨迹', () => {
    const messages = buildRepoSynthesisMessages('ReAct loop 怎么实现？', [
      { path: 'src/agent.ts', content: '41|while (next) {\n42|  await run(next);\n43|}' },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('ReAct loop 怎么实现？');
    expect(messages[1]?.content).toContain('## src/agent.ts');
    expect(messages[1]?.content).toContain('41|while (next)');
    expect(messages.some((message) => message.content.includes('assistant.tool_calls'))).toBe(false);
    expect(messages.some((message) => message.content.includes('<tool_call'))).toBe(false);
    expect(messages[0]?.content).toContain('第一行必须以“结论：”开头');
  });

  it('限制证据体积，避免总结请求再次撑爆上下文', () => {
    const messages = buildRepoSynthesisMessages('问题', [
      { path: 'huge.ts', content: 'x'.repeat(100_000) },
    ]);
    expect(messages[1]!.content.length).toBeLessThan(61_000);
  });

  it('由模型根据源码语义判断是否适合生成流程图', () => {
    const messages = buildRepoSynthesisMessages('解释 ReAct loop', [
      { path: 'agent.ts', content: '1|while (next) {}' },
    ]);
    expect(messages[0]!.content).toContain('先根据问题和源码证据判断');
    expect(messages[0]!.content).toContain('不存在时用一句话说明不适合生成流程图');
  });

  it('不可交付后的重写进入严格定稿模式', () => {
    const messages = buildRepoSynthesisMessages(
      '解释 Agent',
      [{ path: 'agent.ts', content: '1|export function run() {}' }],
      true,
    );
    expect(messages[0]!.content).toContain('上一次输出不可交付');
    expect(messages[1]!.content).toContain('请现在提交最终报告');
  });
});

describe('最终回答判定', () => {
  it('有效文字回答不会因为没有 Mermaid 被重试', () => {
    expect(
      shouldRetryRepoSynthesis({
        text: '结论：源码只定义了一个静态配置，不存在可验证的执行流程。',
        truncated: false,
      }),
    ).toBe(false);
  });
});
