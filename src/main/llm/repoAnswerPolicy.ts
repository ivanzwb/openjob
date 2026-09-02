/**
 * 某些 OpenAI-compatible 端点会把内部工具协议同时放进 content：
 *
 *   <tool_call><function=grep>...</function></tool_call>
 *
 * 原生 tool_calls 仍然存在，所以工具确实会执行；但旧循环把每一轮 content 都拼进
 * finalText，最终用户看到的就会是协议转储而不是答案。这里识别的是「回答主体仍是
 * 工具协议」的情况，正常正文里偶尔提到 tool_call 不会被挡掉。
 */
export function looksLikeToolProtocol(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const markers = trimmed.match(
    /<\/?(?:tool_call|function(?:=[^>\s]+)?|parameter(?:=[^>\s]+)?)>/gi,
  );
  if (!markers?.length) return false;

  const withoutProtocol = trimmed
    .replace(/<\/?(?:tool_call|function(?:=[^>\s]+)?|parameter(?:=[^>\s]+)?)>/gi, '')
    .replace(/\b(?:path|pattern|start_line|end_line)\b/gi, '')
    .replace(/[{}"':,./\\\s_-]/g, '');

  // 至少两个协议标记，且剥掉协议后没有成段的人类说明。
  return markers.length >= 2 && withoutProtocol.length < 80;
}

export function shouldRetryRepoSynthesis(input: {
  text: string;
  truncated: boolean;
}): boolean {
  return !input.text.trim() || input.truncated || looksLikeToolProtocol(input.text);
}

export const READ_CODE_BEFORE_ANSWER = `你还没有成功调用 read_file 打开源码。
当前结果不能作为回答。请根据已有定位结果，通过接口的函数调用能力执行 read_file，
读取实现文件的关键区间；这一轮消息正文保持为空。`;

export const FINAL_REPO_SYNTHESIS = `你现在是技术报告撰写器。本轮是最终定稿，所需源码证据已经完整提供。
- 第一行必须以“结论：”开头，随后只输出普通 Markdown 正文；
- 只根据提供的源码证据总结；
- 按执行顺序解释关键步骤，并给每个代码结论附 path:line；
- 先根据问题和源码证据判断是否存在可验证的时序、分支、循环或调用关系；
  确实存在时加入 mermaid flowchart，不存在时用一句话说明不适合生成流程图，不要强行画图；
- 直接完成报告，不描述调查过程或下一步计划。`;

export interface RepoReadEvidence {
  path: string;
  content: string;
}

const MAX_SYNTHESIS_EVIDENCE_CHARS = 60_000;

/**
 * 最终总结使用一段全新的上下文，而不是接着 assistant.tool_calls → tool 的轨迹续写。
 * 一些兼容端点即使不再传 tools，只要看到那段轨迹仍会继续生成 XML 工具协议；
 * 新上下文里只有用户问题与 read_file 的实际结果，模型没有协议可模仿。
 */
export function buildRepoSynthesisMessages(
  question: string,
  evidence: RepoReadEvidence[],
  retryFinal = false,
): Array<{ role: 'system' | 'user'; content: string }> {
  let remaining = MAX_SYNTHESIS_EVIDENCE_CHARS;
  const sections: string[] = [];

  for (const item of evidence) {
    if (remaining <= 0) break;
    const header = `## ${item.path}\n`;
    const body = item.content.slice(0, Math.max(0, remaining - header.length));
    if (!body) break;
    sections.push(`${header}${body}`);
    remaining -= header.length + body.length;
  }

  return [
    {
      role: 'system',
      content: [
        FINAL_REPO_SYNTHESIS,
        retryFinal ? '上一次输出不可交付；本次请严格从“结论：”开始完成整篇报告。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: `# 需要回答的问题\n${question}\n\n# 已核验的源码证据\n${
        sections.join('\n\n') || '（没有可用源码证据）'
      }\n\n请现在提交最终报告。`,
    },
  ];
}

