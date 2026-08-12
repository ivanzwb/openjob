export interface ResumeOptimizeSection {
  key: string;
  title: string;
  contentMd: string;
}

export interface ResumeOptimizeChangelogItem {
  sectionKey: string;
  summary: string;
}

export interface ResumeOptimizeGenerated {
  sections: ResumeOptimizeSection[];
  changelog: ResumeOptimizeChangelogItem[];
}

export const RESUME_OPTIMIZE_SYSTEM = `你是资深简历顾问与面试官，帮候选人把简历改写得更贴合目标岗位 JD。

硬性规则：
1. 不得编造候选人未提及的公司、项目、职级、年限、数字成果；不确定处写「（待确认）」。
2. 优先优化表述、结构、关键词对齐、量化表达（仅当原文已有数据时可改写得更清晰）。
3. 输出 JSON，sections 按简历常见结构分段（summary / skills / experience / projects / education 等，按原文实际内容取舍）。
4. 每个 section 的 contentMd 用 markdown，适合后续导出 PDF。
5. changelog 简要说明每段相对原文的主要改动意图（补 JD 关键词、强化匹配、弱化无关等）。`;

export function buildResumeOptimizeUserPrompt(
  company: string,
  roleTitle: string,
  jdRaw: string,
  resumeText: string,
): string {
  return `目标公司：${company}
目标岗位：${roleTitle}

岗位 JD：
${jdRaw.slice(0, 12000)}

候选人当前简历原文：
${resumeText.slice(0, 12000)}

请输出 JSON：
{
  "sections": [{ "key": "summary", "title": "个人总结", "contentMd": "..." }],
  "changelog": [{ "sectionKey": "summary", "summary": "改动说明" }]
}`;
}

export function assembleResumeMarkdown(sections: ResumeOptimizeSection[]): string {
  return sections
    .map((s) => `## ${s.title}\n\n${s.contentMd.trim()}`)
    .join('\n\n');
}

export function assembleChangelogMarkdown(changelog: ResumeOptimizeChangelogItem[]): string {
  if (changelog.length === 0) return '';
  return changelog.map((c) => `- **${c.sectionKey}**：${c.summary}`).join('\n');
}

export function defaultVariantLabel(company: string, roleTitle: string): string {
  return `${company} · ${roleTitle}`;
}
