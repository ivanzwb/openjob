/**
 * 简历的两个模型动作：重新归类（AI 识别）与单块润色（AI 优化）。
 *
 * 桌面走主进程的 completeJson，手机直连模型自己的 completeJson，
 * 两端只在这里注入实现，提示词、兜底与校验逻辑保持一份。
 */

import type { ResumeSectionKey } from './document';
import {
  RESUME_SECTION_CATALOG,
  catalogTitleForKey,
  documentToMarkdown,
  inferSectionKey,
  parseMarkdownToDocument,
} from './document';
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

export interface ResumeStructureOutcome {
  contentMd: string;
  /** 模型用不上时退回了规则识别，带上原因供界面提示用户 */
  fallbackReason?: string;
}

/**
 * 不用模型的兜底：只把还堆在「其他」里的内容交给规则识别重新分配，
 * 已经归好类的模块原样保留——否则会把模型分对的结果又打散。
 * 规则识别一个模块都拆不出来时返回 null，让调用方报错而不是假装成功。
 */
function structureUnclassifiedByRules(md: string): string | null {
  const doc = parseMarkdownToDocument(md);
  const unclassified = doc.sections.find((s) => s.key === 'other')?.contentMd.trim() ?? '';
  if (!unclassified) return null;

  const extracted = parseMarkdownToDocument(structureResumeText(unclassified));
  const gained = extracted.sections.some((s) => s.key !== 'other' && s.contentMd.trim());
  if (!gained) return null;

  return documentToMarkdown({
    sections: doc.sections.map((s) => {
      // 「其他」整块交给了规则识别，这里只用重新分配后的结果
      const kept = s.key === 'other' ? '' : s.contentMd.trim();
      const added = extracted.sections.find((e) => e.key === s.key)?.contentMd.trim() ?? '';
      return { ...s, contentMd: [kept, added].filter(Boolean).join('\n\n') };
    }),
  });
}

/**
 * 规则识别搞不定的简历（双栏 PDF、没有小标题）交给模型重新归类。
 * 只归类不改写，输出仍是 `## 模块` 的 markdown，与手工编辑的格式一致。
 *
 * 模型报错或没给出可用结构时都退回规则识别，并把原因带回去：
 * 用户至少能拿到一版归类，同时知道这版不是模型给的。
 */
export async function structureResumeWithLlm(
  complete: ResumeJsonCompleter,
  rawText: string,
): Promise<ResumeStructureOutcome> {
  const text = rawText.trim();
  if (!text) throw new Error('简历内容为空');

  let failure: string;
  try {
    const generated = await complete<{ sections?: ResumeOptimizeSection[] }>(
      RESUME_STRUCTURE_SYSTEM,
      buildResumeStructureUserPrompt(text),
    );
    const blocks = (generated.sections ?? [])
      .filter((s) => s?.contentMd?.trim())
      .map((s) => `## ${catalogTitleForKey(normalizeKey(s))}\n\n${s.contentMd.trim()}`);
    if (blocks.length > 0) return { contentMd: blocks.join('\n\n') };
    failure = '模型没有给出可用的模块划分';
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const fallback = structureUnclassifiedByRules(text);
  if (!fallback) throw new Error(`${failure}；规则识别也没能拆出模块，请检查内容或手动整理`);
  return { contentMd: fallback, fallbackReason: failure };
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
