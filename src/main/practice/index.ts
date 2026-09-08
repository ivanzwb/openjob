/**
 * 练习引擎的进程内单例与对外入口。
 *
 * 单例在这里而不在 service.ts：service 的依赖全部显式传入，用例才能对着一份真的
 * 跑过迁移的内存库跑完整流程，而不是靠打桩模拟出一套 DB 行为。
 */

import type {
  PracticeAttempt,
  PracticeAttemptQuery,
  PracticeDimensionScore,
} from '@shared/practice';
import { getRawDb } from '../db';
import { completeComposedJson } from '../llm/json';
import { getPracticeAttemptScores, listPracticeHistory } from './history';
import { createPracticeService, type PracticeService } from './service';

export { writeMasterySignal } from './mastery';
export { createPracticeService, type PracticeService } from './service';
export { listPracticeHistory, getPracticeAttemptScores } from './history';
export {
  resolveCampaignPracticeRuntime,
  legacyExamFormForFormatId,
  findRolePack,
} from './rolePack';

let service: PracticeService | null = null;

export function getPracticeService(): PracticeService {
  if (!service) {
    service = createPracticeService({
      raw: getRawDb(),
      completeJson: completeComposedJson,
    });
  }
  return service;
}

export function listPracticeAttempts(query: PracticeAttemptQuery): PracticeAttempt[] {
  return listPracticeHistory(getRawDb(), query);
}

export function listPracticeScores(attemptId: string): PracticeDimensionScore[] {
  return getPracticeAttemptScores(getRawDb(), attemptId);
}
