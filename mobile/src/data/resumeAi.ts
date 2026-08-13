import {
  polishResumeSection as polishSection,
  structureResumeWithLlm as structureWithLlm,
  type ResumeJsonCompleter,
  type ResumePolishRequest,
} from '@shared/resume/aiEdit';
import { completeJson } from '../llm/json';

const complete: ResumeJsonCompleter = (system, user) =>
  completeJson('resumeOptimize', system, user);

/** 把一段乱序内容重新归类到固定模块，返回 markdown，交给界面预览后再落库 */
export function structureResume(rawText: string): Promise<string> {
  return structureWithLlm(complete, rawText);
}

/** 基于整份简历优化当前这一块，返回文本，用户决定采用或撤销 */
export function polishResume(input: ResumePolishRequest): Promise<string> {
  return polishSection(complete, input);
}
