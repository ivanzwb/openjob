import { describe, expect, it } from 'vitest';
import {
  buildRepoSynthesisMessages,
  hasMermaidDiagram,
  looksLikeToolProtocol,
  needsFlowDiagram,
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
  });

  it('限制证据体积，避免总结请求再次撑爆上下文', () => {
    const messages = buildRepoSynthesisMessages('问题', [
      { path: 'huge.ts', content: 'x'.repeat(100_000) },
    ]);
    expect(messages[1]!.content.length).toBeLessThan(61_000);
  });
});

describe('流程图判定', () => {
  it.each(['ReAct loop 是怎么实现的', '启动流程是什么', '解释请求生命周期', 'architecture'])(
    '流程类问题要求 Mermaid：%s',
    (question) => expect(needsFlowDiagram(question)).toBe(true),
  );

  it('查一个配置值不强制画图', () => {
    expect(needsFlowDiagram('默认超时时间是多少')).toBe(false);
  });

  it('只接受完整的 mermaid 围栏', () => {
    expect(hasMermaidDiagram('```mermaid\nflowchart TD\nA-->B\n```')).toBe(true);
    expect(hasMermaidDiagram('mermaid flowchart TD A-->B')).toBe(false);
  });
});
