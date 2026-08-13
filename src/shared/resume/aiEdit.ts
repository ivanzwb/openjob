/**
 * 简历的两个模型动作：重新归类（AI 识别）与单块润色（AI 优化）。
 *
 * 桌面走主进程的 completeJson，手机直连模型自己的 completeJson，
 * 两端只在这里注入实现，提示词、兜底与校验逻辑保持一份。
 */

import type { ResumeSectionKey } from './document';
import { RESUME_SECTION_CATALOG, catalogTitleForKey, inferSectionKey } from './document';
import { structureResumeText } from './importStructure';
import {
  RESUME_POLISH_SYSTEM,
  RESUME_STRUCTURE_SYSTEM,
  buildResumePolishUserPrompt,
  buildResumeStructureUserPrompt,
  type ResumeOptimizeSection,
} from './prompts';

/** 用 resumeOptimize 角色请求一段 JSON，由调用方决定怎么访问模型 */
export type ResumeJsonCompleter = <T>(system: string, user: string) => Promise<T>;

export interface ResumePolishRequest {
  /** 整份简历 markdown，供模型理解上下文 */
  resumeMd: string;
  /** 固定模块 key，如 summary / skills / experience */
  sectionKey: string;
  /** 定位到具体条目，如「腾讯科技 | 前端工程师」 */
  scopeLabel?: string;
  /** 当前文本框内容，可为空 */
  contentMd: string;
  /** 用户的额外要求，可为空 */
  instruction?: string;
}

const KEYS = new Set<string>(RESUME_SECTION_CATALOG.map((c) => c.key));

/** 模型给的 key 不可信，认不出就退回按标题推断 */
function normalizeKey(section: ResumeOptimizeSection): ResumeSectionKey {
  if (KEYS.has(section.key)) return section.key as ResumeSectionKey;
  return inferSectionKey(section.title ?? '');
}

function sectionTitle(key: string): string {
  const known = RESUME_SECTION_CATALOG.find((c) => c.key === key);
  return known ? catalogTitleForKey(known.key as ResumeSectionKey) : '其他';
}

/**
 * 规则识别搞不定的简历（双栏 PDF、没有小标题）交给模型重新归类。
 * 只归类不改写，输出仍是 `## 模块` 的 markdown，与手工编辑的格式一致。
 */
export async function structureResumeWithLlm(
  complete: ResumeJsonCompleter,
  rawText: string,
): Promise<string> {
  const text = rawText.trim();
  if (!text) throw new Error('简历内容为空');

  const generated = await complete<{ sections?: ResumeOptimizeSection[] }>(
    RESUME_STRUCTURE_SYSTEM,
    buildResumeStructureUserPrompt(text),
  );

  const blocks = (generated.sections ?? [])
    .filter((s) => s?.contentMd?.trim())
    .map((s) => `## ${catalogTitleForKey(normalizeKey(s))}\n\n${s.contentMd.trim()}`);

  if (blocks.length === 0) {
    // 模型没给出可用结构时退回规则识别，至少不让用户白等
    const fallback = structureResumeText(text);
    if (fallback === text) throw new Error('未能识别出简历结构，请检查内容或手动整理');
    return fallback;
  }

  return blocks.join('\n\n');
}

/**
 * 只重写用户当前编辑的那一块：整份简历作为上下文，用户要求作为优先约束。
 * 结果交回给界面，由用户决定采用或撤销，不落库。
 */
export async function polishResumeSection(
  complete: ResumeJsonCompleter,
  input: ResumePolishRequest,
): Promise<string> {
  const resumeMd = input.resumeMd.trim();
  if (!resumeMd && !input.contentMd.trim()) throw new Error('简历还没有内容可供优化');

  const generated = await complete<{ contentMd?: string }>(
    RESUME_POLISH_SYSTEM,
    buildResumePolishUserPrompt({
      sectionTitle: sectionTitle(input.sectionKey),
      scopeLabel: input.scopeLabel,
      resumeMd,
      contentMd: input.contentMd,
      instruction: input.instruction ?? '',
    }),
  );

  const contentMd = (generated.contentMd ?? '').trim();
  if (!contentMd) throw new Error('模型没有返回可用内容，请补充要求后再试');
  return contentMd;
}
