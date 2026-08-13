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

export const RESUME_OPTIMIZE_SYSTEM = `你是资深简历顾问，帮候选人把**已有**简历改写得更贴合目标岗位 JD。

## 最高优先级：事实忠实（违反则整份输出无效）
优化版简历中的每一条事实必须能在「候选人当前简历原文」中找到依据。你是改写员，不是编剧。

**严禁编造或臆测：**
- 公司名、部门、岗位名称、职级、工作/项目时间
- 项目名称、业务场景、职责范围、技术栈（未在原文出现的名词一律不得写入正文）
- 数字成果（用户数、QPS、营收、团队人数、性能提升百分比等）——原文没有就不能写；原文有则可以改写得更清晰
- 证书、奖项、教育经历、开源贡献等原文未提及的内容

**允许的操作：**
- 调整段落顺序与结构，使 JD 关键词与匹配经历更靠前
- 用更专业、简洁的表述重写**已有**句子；合并或拆分原文已有要点
- 在 summary/skills 中突出原文已出现、且与 JD 相关的技术词（不得新增技能）
- 弱化或缩短与 JD 无关、但原文里有的内容（删减须在 changelog 说明）

**JD 有要求但简历没有时：**
- 正文里**不要**假装具备该经历或技能
- 可在 changelog 中标注「JD 要求 X，原文未体现，未写入优化版」

## 输出格式
1. 输出 JSON；sections 按简历常见结构分段（basic / summary / skills / experience / projects / education 等，仅保留原文实际有的块）
2. 每个 section 的 contentMd 用 markdown，并遵守以下书写约定（排版渲染依赖它）：
   - 基本信息：每行一项「标签：值」，如「姓名：张三」「电话：138…」「邮箱：…」
   - 工作/项目/教育经历：每段以 \`### 机构 | 岗位或角色 | 2022-03 ~ 至今\` 开头，时间放最后一段
   - 职责与成果用 \`- \` 分条，一条一句
   - 不要写 \`#\` / \`##\` 标题，段落名由 title 字段提供
3. changelog 说明每段改动意图（关键词对齐、结构调整、弱化无关等），并注明是否有事实删减；不得把「新增事实」写成改动说明`;

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

候选人当前简历原文（优化版全部事实只能来源于此，不得外推或编造）：
${resumeText.slice(0, 12000)}

再次强调：优化版中出现的公司、项目、职责、技术、数据必须与上文原文一致或为原文的同义改写；JD 里要求但原文没有的能力不要写进正文。

请输出 JSON：
{
  "sections": [{ "key": "summary", "title": "个人总结", "contentMd": "..." }],
  "changelog": [{ "sectionKey": "summary", "summary": "改动说明（勿声称添加了原文没有的经历或数据）" }]
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
