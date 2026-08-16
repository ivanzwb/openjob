import type { ResumePolishInput } from '@shared/ipc';
import {
  polishResumeSection as polishSection,
  structureResumeWithLlm as structureWithLlm,
  type ResumeJsonCompleter,
  type ResumeStructureOutcome,
} from '@shared/resume/aiEdit';
import { completeJson } from '../llm/json';

const complete: ResumeJsonCompleter = (promptId, user) =>
  completeJson('resumeOptimize', promptId, user);

export function structureResumeWithLlm(rawText: string): Promise<ResumeStructureOutcome> {
  return structureWithLlm(complete, rawText);
}

export function polishResumeSection(input: ResumePolishInput): Promise<string> {
  return polishSection(complete, input);
}
