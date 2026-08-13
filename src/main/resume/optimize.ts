import type { ResumeOptimizeGenerated } from '@shared/resume/prompts';
import {
  assembleChangelogMarkdown,
  assembleResumeMarkdown,
  buildResumeOptimizeUserPrompt,
  defaultVariantLabel,
  RESUME_OPTIMIZE_SYSTEM,
} from '@shared/resume/prompts';
import { completeJson } from '../llm/json';
import type { getResumeVariant } from './variantRepository';
import {
  createResumeVariantRecord,
  getJobTargetForOptimize,
  getSourceResumeText,
} from './variantRepository';

export async function optimizeResumeForJobTarget(
  sourceResumeId: string,
  jobTargetId: string,
): Promise<ReturnType<typeof getResumeVariant>> {
  const target = getJobTargetForOptimize(jobTargetId);
  const resumeText = getSourceResumeText(sourceResumeId);

  const generated = await completeJson<ResumeOptimizeGenerated>(
    'resumeOptimize',
    RESUME_OPTIMIZE_SYSTEM,
    buildResumeOptimizeUserPrompt(target.company, target.roleTitle, target.jdRaw, resumeText),
  );

  const contentMd = assembleResumeMarkdown(generated.sections ?? []);
  const changelogMd = assembleChangelogMarkdown(generated.changelog ?? []);
  const label = defaultVariantLabel(target.company, target.roleTitle);

  return createResumeVariantRecord(
    sourceResumeId,
    jobTargetId,
    label,
    contentMd,
    changelogMd,
    false,
  );
}
