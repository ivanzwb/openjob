import type { ResumePolishInput } from '@shared/ipc';
import type { ResumeSectionKey } from '@shared/resume/document';
import { RESUME_SECTION_CATALOG, catalogTitleForKey } from '@shared/resume/document';
import { RESUME_POLISH_SYSTEM, buildResumePolishUserPrompt } from '@shared/resume/prompts';
import { completeJson } from '../llm/json';

function sectionTitle(key: string): string {
  const known = RESUME_SECTION_CATALOG.find((c) => c.key === key);
  return known ? catalogTitleForKey(known.key as ResumeSectionKey) : '其他';
}

/**
 * 只重写用户当前编辑的那一块：整份简历作为上下文，用户要求作为优先约束。
 * 结果直接回给渲染进程，由用户决定采用或撤销，不落库。
 */
export async function polishResumeSection(input: ResumePolishInput): Promise<string> {
  const resumeMd = input.resumeMd.trim();
  if (!resumeMd && !input.contentMd.trim()) throw new Error('简历还没有内容可供优化');

  const generated = await completeJson<{ contentMd?: string }>(
    'resumeOptimize',
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
