/**
 * 考我 / 追问 的候选人上下文块，双端共用。
 *
 * 拼装本身没法整个共享——桌面走 drizzle、手机走 expo-sqlite。但措辞和 label
 * 必须一致：这个仓库已经吃过双端各写一份的亏（同一个功能两边行为不一样，
 * 改一边忘一边）。所以两端各自查库，把普通值传进来，由这里决定长什么样。
 *
 * label 沿用模拟面试 buildInterviewContext 那一套（「JD 摘要：」「简历技能：」
 * 「简历经历（…）」），让模型在不同功能里看到的是同一种方言。
 */

import {
  formatResumeExperienceForPrompt,
  resumeExperienceBlock,
  type FallbackProject,
} from '../resume/experienceTimeline';

/** JD 摘要在考我/追问里只用来定重点，给全文既挤占篇幅又容易被当经历取材 */
const JD_SUMMARY_LIMIT = 800;

export interface CandidateContextInput {
  company: string;
  roleTitle: string;
  jdSummary?: string | null;
  resumeSkills?: string[] | null;
  resumeRawText?: string | null;
  resumeProjects?: FallbackProject[] | null;
}

export interface NodeContextInput {
  name: string;
  coverageType?: string | null;
  examForms?: string[] | null;
}

/**
 * 简历确实没关联时要明说。
 *
 * 只留一句「（未提供）」的话，上下文里 JD 仍然很厚，模型会自然地拿它填「候选人
 * 做过什么」这个空位——这正是用户报的那个症状。明确写出该怎么办，比留白安全。
 */
const NO_RESUME_NOTICE = `简历：（尚未关联简历）
- 不要虚构候选人的项目或经历，也不要拿 JD、公司技术栈里的内容冒充他做过的事。
- 需要举例时用通用场景，并标注「可换成你简历里的对应经历」。`;

/**
 * 判断依据必须是「拼得出内容」，不能是「rawText 非空」。
 *
 * 简历导入了但一条带时间的经历都解析不出来时（纯文本简历、格式不规范），
 * rawText 非空而经历块是空的，走「有简历」分支只会输出一串「（未提供）」标签，
 * 一句指引都没有——那正是这条 notice 要防的局面，等于白防。
 */
function hasUsableResume(input: CandidateContextInput, skills: string[]): boolean {
  if (skills.length > 0) return true;
  if ((input.resumeProjects ?? []).length > 0) return true;
  return formatResumeExperienceForPrompt(input.resumeRawText ?? '') !== '';
}

export function buildCandidateContext(
  input: CandidateContextInput,
  node?: NodeContextInput,
): string {
  const lines: string[] = [`公司：${input.company}`, `岗位：${input.roleTitle}`];

  const jd = (input.jdSummary ?? '').trim();
  lines.push(`JD 摘要：${jd ? jd.slice(0, JD_SUMMARY_LIMIT) : '（未提供）'}`);

  if (node) {
    lines.push(`考点：${node.name}`);
    if (node.coverageType) lines.push(`覆盖类型：${node.coverageType}`);
    if (node.examForms && node.examForms.length > 0) {
      lines.push(`考察形式：${node.examForms.join(', ')}`);
    }
  }

  const skills = (input.resumeSkills ?? []).filter((s) => s.trim().length > 0);
  if (hasUsableResume(input, skills)) {
    lines.push(`简历技能：${skills.length > 0 ? skills.join('、') : '（未提供）'}`);
    lines.push(resumeExperienceBlock(input.resumeRawText ?? '', input.resumeProjects));
  } else {
    lines.push(NO_RESUME_NOTICE);
  }

  return lines.join('\n');
}
