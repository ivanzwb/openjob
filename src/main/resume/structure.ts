import type { ResumeSectionKey } from '@shared/resume/document';
import { RESUME_SECTION_CATALOG, catalogTitleForKey, inferSectionKey } from '@shared/resume/document';
import { structureResumeText } from '@shared/resume/importStructure';
import {
  RESUME_STRUCTURE_SYSTEM,
  buildResumeStructureUserPrompt,
  type ResumeOptimizeSection,
} from '@shared/resume/prompts';
import { completeJson } from '../llm/json';

const KEYS = new Set<string>(RESUME_SECTION_CATALOG.map((c) => c.key));

/** 模型给的 key 不可信，认不出就退回按标题推断 */
function normalizeKey(section: ResumeOptimizeSection): ResumeSectionKey {
  if (KEYS.has(section.key)) return section.key as ResumeSectionKey;
  return inferSectionKey(section.title ?? '');
}

/**
 * 规则识别搞不定的简历（双栏 PDF、没有小标题）交给模型重新归类。
 * 只归类不改写，输出仍是 `## 模块` 的 markdown，与手工编辑的格式一致。
 */
export async function structureResumeWithLlm(rawText: string): Promise<string> {
  const text = rawText.trim();
  if (!text) throw new Error('简历内容为空');

  const generated = await completeJson<{ sections?: ResumeOptimizeSection[] }>(
    'resumeOptimize',
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
