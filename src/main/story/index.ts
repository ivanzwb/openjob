/**
 * Story 工作台的进程内单例与对外入口。
 *
 * 单例在这里而不在 service.ts：service 的依赖全部显式传入，用例才能对着一份真跑过
 * 迁移的内存库跑完整流程，而不是打桩模拟一套 DB 行为。
 */

import { getRawDb } from '../db';
import { completeComposedJson } from '../llm/json';
import { createStoryService, type StoryService } from './service';

export { createStoryService, resolveStoryDeliveryFormat, type StoryService } from './service';
export {
  getStory,
  listStories,
  listConfirmedStoryEvidence,
  listDeliveries,
} from './repository';

let service: StoryService | null = null;

export function getStoryService(): StoryService {
  if (!service) {
    service = createStoryService({
      raw: getRawDb(),
      completeJson: completeComposedJson,
    });
  }
  return service;
}
