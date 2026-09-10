/**
 * STAR/CAR Story 的共享契约。
 *
 * Story 不是「再存一份经历」，而是把已确认证据组织成一段可以在面试现场说出口的
 * 叙事。所以两件事写进类型，不靠调用方自觉：
 *
 * 1. `evidenceIds` 至少一条，且只能是已确认证据。一个没有事实支撑的 Story 会被
 *    当成真经历反复背诵、反复口述，最终带进考场——这正是 fail-closed 要挡住的
 *    东西，所以 create 和 revise 两侧都必须挡，而不是只在新建时挡一次。
 * 2. `createDelivery` 的入参只有 Story id 和时长。三个口述版本因此不可能各自
 *    带一份事实进来：它们全部由同一行 Story 加同一组证据推导（见 factSet.ts），
 *    时长只决定压缩到多短。
 */

import type { SpeechSnippet } from '../entities';

/**
 * 口述时长档位。
 *
 * 三档对应三种真实场景：30 秒是自我介绍里的一句带过，60 秒是「讲一个你最有成就感
 * 的项目」，120 秒是允许追问的深挖开场。档位是枚举而不是任意秒数：任意时长意味着
 * 每次生成都是一个新版本，用户永远不知道该背哪一条。
 */
export const STORY_DELIVERY_DURATIONS = [30, 60, 120] as const;
export type StoryDeliveryDuration = (typeof STORY_DELIVERY_DURATIONS)[number];

export function isStoryDeliveryDuration(value: unknown): value is StoryDeliveryDuration {
  return STORY_DELIVERY_DURATIONS.includes(value as StoryDeliveryDuration);
}

/** 一段可复用的真实经历，按 STAR/CAR 分段存放 */
export interface Story {
  id: string;
  campaignId: string;
  title: string;
  situationMd: string;
  taskMd: string;
  actionMd: string;
  resultMd: string;
  /** CAR 里没有这一段，STAR 复盘时才写；允许为空串 */
  reflectionMd: string;
  /**
   * 关联的已确认证据，至少一条。
   *
   * 顺序不承载语义（事实集合按证据 id 排序后取指纹），但保留写入顺序方便界面
   * 按用户挑选的次序展示。
   */
  evidenceIds: string[];
  /** T11 的能力实例；本任务只负责存取，不参与事实集合 */
  competencyIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StoryInput {
  campaignId: string;
  title: string;
  situationMd: string;
  taskMd: string;
  actionMd: string;
  resultMd: string;
  reflectionMd?: string;
  /** 至少一条已确认证据，否则 create 直接拒绝，库里不留半条 Story */
  evidenceIds: string[];
  competencyIds?: string[];
}

/** 只给出要改的字段；campaignId 不可改——换 Campaign 等于换了一套证据 */
export type StoryPatch = Partial<Omit<StoryInput, 'campaignId'>>;

/**
 * 一个已生成的口述版本。
 *
 * 正文存在 speech_snippet 里（sourceType='story'），这张表只记「哪个 Story 的
 * 哪一档、依据的是哪一份事实集合」。`factSetHash` 是三档共享事实集合这条验收
 * 的落库证据：三行的 hash 必须一样，不一样就说明某一档是在另一组事实上生成的。
 */
export interface StoryDelivery {
  id: string;
  storyId: string;
  snippetId: string;
  durationSeconds: StoryDeliveryDuration;
  factSetHash: string;
  promptVersionId: string;
  createdAt: number;
}

/** 带上正文的口述版本，供界面直接渲染 */
export interface StoryDeliveryView extends StoryDelivery {
  contentMd: string;
  isUserEdited: boolean;
}

export interface StoryProtocol {
  create(input: StoryInput): Promise<Story>;
  revise(id: string, patch: StoryPatch): Promise<Story>;
  createDelivery(id: string, duration: StoryDeliveryDuration): Promise<SpeechSnippet>;
}

export type StoryErrorCode =
  | 'story-not-found'
  | 'campaign-not-found'
  | 'empty-story'
  /** 一条已确认证据都没有：新建与修改都在这里被挡下 */
  | 'missing-evidence'
  /** 给的证据存在但不是 confirmed，或不属于这个 Campaign */
  | 'invalid-evidence'
  /** 这场备考还没有可用的插件运行时或岗位包 */
  | 'runtime-unavailable'
  | 'no-delivery-format'
  | 'unreadable-delivery'
  /** 口述里出现了事实集合里没有的数字 */
  | 'ungrounded-delivery';

export class StoryError extends Error {
  readonly code: StoryErrorCode;
  readonly detail?: string;

  constructor(code: StoryErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'StoryError';
    this.code = code;
    this.detail = detail;
  }
}
