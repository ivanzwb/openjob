/**
 * 考我 / 追问 / 模拟面试细化 的候选人上下文装配。
 *
 * 单独一个文件有两个原因：
 * 1. 这几条链路原先各自手拼 user message、干脆没查简历，模型手里只有岗位名，
 *    要举例就只能照着 JD 编一段「候选人做过的项目」。装配收到一处才不会漏。
 * 2. 手机端单测跑在 node 上，import 到 expo-crypto 那类模块整个文件就起不来。
 *    这里只 type-import expo-sqlite（类型会被擦除），所以拼装逻辑测得到。
 *
 * 文本长什么样由 @shared/prompts/candidateContext 决定，两端共用同一份，
 * 别在这里另拼一套。
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import type { KnowledgeNode } from '@shared/entities';
import {
  buildCandidateContext,
  jdSummaryForPrompt,
  type CandidateContextInput,
  type NodeContextInput,
} from '@shared/prompts/candidateContext';
import { resolvePrompt } from '@shared/prompts/registry';
import type { FallbackProject } from '@shared/resume/experienceTimeline';
import { getCampaign, getKnowledgeNode } from './campaignLocal';

export interface ResumePromptRow {
  parsed: string | null;
  raw_text: string | null;
}

export interface ResumePromptFields {
  skills: string[];
  projects: FallbackProject[];
  rawText: string;
}

// JD 摘要曾在这里和桌面端各存一份逐字相同的实现，现已收进共享层
export { jdSummaryForPrompt };

/** parsed 是 TEXT 列，存进去的 JSON 坏了不该拦住出题，退回空值即可 */
export function parseResumeForPrompt(row: ResumePromptRow | null | undefined): ResumePromptFields {
  const rawText = row?.raw_text ?? '';
  if (!row?.parsed) return { skills: [], projects: [], rawText };
  try {
    const parsed = JSON.parse(row.parsed) as {
      projects?: FallbackProject[];
      skills?: string[];
    };
    return { skills: parsed.skills ?? [], projects: parsed.projects ?? [], rawText };
  } catch {
    return { skills: [], projects: [], rawText };
  }
}

export function loadResumeForPrompt(
  db: SQLiteDatabase,
  resumeId: string | null,
): ResumePromptFields {
  const row = resumeId
    ? db.getFirstSync<ResumePromptRow>(`SELECT parsed, raw_text FROM resume WHERE id = ?`, resumeId)
    : null;
  return parseResumeForPrompt(row);
}

export function loadCandidateContextInput(
  db: SQLiteDatabase,
  campaignId: string,
): CandidateContextInput {
  const campaign = getCampaign(db, campaignId);
  const resume = loadResumeForPrompt(db, campaign.resumeId);
  return {
    company: campaign.company,
    roleTitle: campaign.roleTitle,
    jdSummary: jdSummaryForPrompt(campaign),
    resumeSkills: resume.skills,
    resumeRawText: resume.rawText,
    resumeProjects: resume.projects,
  };
}

export function nodeContextFor(
  node: Pick<KnowledgeNode, 'name' | 'coverageType' | 'examForms'>,
): NodeContextInput {
  return { name: node.name, coverageType: node.coverageType, examForms: node.examForms };
}

export interface QuizPromptContext {
  candidate: CandidateContextInput;
  nodeContext: NodeContextInput;
}

export function loadQuizPromptContext(
  db: SQLiteDatabase,
  nodeId: string,
): QuizPromptContext & { node: KnowledgeNode } {
  const node = getKnowledgeNode(db, nodeId);
  return {
    node,
    candidate: loadCandidateContextInput(db, node.campaignId),
    nodeContext: nodeContextFor(node),
  };
}

export function quizQuestionUserMessage(context: QuizPromptContext): string {
  return buildCandidateContext(context.candidate, context.nodeContext);
}

export function quizAnswerUserMessage(context: QuizPromptContext, question: string): string {
  return `${buildCandidateContext(context.candidate, context.nodeContext, {
    userText: question,
  })}
问题：${question}`;
}

export function quizScoreUserMessage(
  context: QuizPromptContext,
  question: string,
  userAnswer: string,
): string {
  return `${buildCandidateContext(context.candidate, context.nodeContext, {
    userText: `${question}\n${userAnswer}`,
  })}
问题：${question}
候选人回答：${userAnswer}`;
}

/**
 * 追问的 system prompt。
 *
 * 放数据层而不是留在组件里：组件手上只有 id，要简历就得在视图层写 SQL；而且
 * 追问和考我必须看到同一份上下文，共用装配才不会再次漂开。
 *
 * 考点或战役查不到（已被删、同步半途）时退回不带简历的那份——少一段上下文
 * 也好过整段对话发不出去。桌面端同一处也是这么兜的。
 */
export function buildNodeFollowUpSystem(
  db: SQLiteDatabase,
  nodeId: string,
  nodeName: string,
): string {
  let candidateContext: string | undefined;
  try {
    const { candidate, nodeContext } = loadQuizPromptContext(db, nodeId);
    candidateContext = buildCandidateContext(candidate, nodeContext);
  } catch (err) {
    // 不留痕的话，「追问看不到简历」会退化成一个永远查不出来的问题
    console.error('[followUp] 装配候选人上下文失败，退回不带简历的 system', err);
    candidateContext = undefined;
  }
  return resolvePrompt('followUp.node', { nodeName, nodeId, candidateContext }).text;
}
