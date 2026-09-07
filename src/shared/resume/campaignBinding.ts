/**
 * 战役与简历的绑定规则（桌面端与移动端共用同一份判定，避免规则漂移）。
 *
 * 背景：战役建好时若没绑简历，出题/参考答案的 prompt 装配里就没有候选人履历，
 * 模型只能输出「[X] 年经验」式占位模板。规则：
 * - 新建战役默认绑「该目标岗位的优化派生版」对应的母版；没有派生版就绑最新母版
 * - prompt 取数时，绑定母版 + 该目标岗位下存在派生自它的优化版 → 正文用派生版
 *   content_md（事实继承自母版，仅表述被改写），skills/projects 仍取母版 parsed
 */

export interface ResumeVariantBrief {
  id: string;
  sourceResumeId: string | null;
  updatedAt: number;
  createdAt: number;
}

export interface ResumeBrief {
  id: string;
  updatedAt: number;
  createdAt: number;
}

function byNewest<T extends { updatedAt: number; createdAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
}

/** 目标岗位下最新的、仍挂得住母版的派生版 */
export function latestVariantOfTarget(variants: ResumeVariantBrief[]): ResumeVariantBrief | null {
  const withSource = variants.filter((v) => v.sourceResumeId !== null);
  return withSource.sort(byNewest)[0] ?? null;
}

/** 派生版及其母版都不存在时退回的最新母版 */
export function latestResume(resumes: ResumeBrief[]): ResumeBrief | null {
  return [...resumes].sort(byNewest)[0] ?? null;
}

/**
 * 战役未显式选简历时的默认绑定：目标岗位有派生版 → 绑派生版的母版（这样
 * prompt 取数能按 source_resume_id 命中派生版），否则绑最新母版。
 */
export function pickDefaultResumeId(
  variantsOfTarget: ResumeVariantBrief[],
  resumes: ResumeBrief[],
): string | null {
  const variant = latestVariantOfTarget(variantsOfTarget);
  if (variant) return variant.sourceResumeId;
  return latestResume(resumes)?.id ?? null;
}

/**
 * 战役实际用于 prompt 的正文来源：绑定母版在目标岗位下有派生版 → 用派生版。
 * resumeId 为空时不猜（避免把别人的派生版安到没绑简历的战役上）。
 */
export function pickVariantForCampaign(
  variantsOfTarget: ResumeVariantBrief[],
  resumeId: string | null,
): ResumeVariantBrief | null {
  if (!resumeId) return null;
  const matching = variantsOfTarget.filter((v) => v.sourceResumeId === resumeId);
  return matching.sort(byNewest)[0] ?? null;
}
