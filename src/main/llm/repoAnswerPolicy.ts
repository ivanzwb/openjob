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

export function needsFlowDiagram(question: string): boolean {
  return /(?:流程|循环|链路|生命周期|架构|怎么实现|如何实现|loop|pipeline|lifecycle|architecture|how\s+.*work)/i.test(
    question,
  );
}

export function hasMermaidDiagram(text: string): boolean {
  return /```mermaid\s+[\s\S]+?```/i.test(text);
}

export const READ_CODE_BEFORE_ANSWER = `你还没有成功调用 read_file 打开源码。
当前结果不能作为回答。请根据已有的 glob / find_symbol / grep 结果，立即调用 read_file
读取实现文件的关键区间；不要复述工具协议，也不要现在总结。`;

export const FINAL_REPO_SYNTHESIS = `工具检索阶段已经结束。现在必须直接回答用户最初的问题：
- 只根据刚才 read_file 真正读到的源码总结，不再请求或输出任何工具调用；
- 先给结论，再按执行顺序解释关键步骤，并给每个代码结论附 path:line；
- 如果用户问的是流程、循环、生命周期或架构，必须给出一个 mermaid flowchart；
- 不要输出 <tool_call>、<function=...>、参数 XML 或“我接下来要读取”等过程文字。`;

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
    { role: 'system', content: FINAL_REPO_SYNTHESIS },
    {
      role: 'user',
      content: `# 用户问题\n${question}\n\n# 已读取的源码证据\n${
        sections.join('\n\n') || '（没有可用源码证据）'
      }`,
    },
  ];
}

