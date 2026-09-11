/**
 * StoryService 的桌面实现：整理经历 → 关联证据 → 生成 30/60/120 秒口述。
 *
 * 三条边界决定了这个文件的形状：
 *
 * 1. **一条已确认证据都没有的 Story 不允许存在**，create 和 revise 两侧都挡。
 *    只在新建时挡是个假门槛：用户完全可以先建一条合规的 Story，再把证据全撤掉、
 *    顺手改个标题，库里就留下一段没有任何事实支撑、却会被反复口述的经历。所以
 *    revise 在写完之后重新数一遍还剩几条 confirmed，为零就整笔回滚。
 *
 * 2. **三档口述共享同一份事实集合**。createDelivery 的入参只有 Story id 和时长，
 *    没有任何位置能塞进一条新事实；事实集合由 buildStoryFactSet 从「Story 那一行
 *    + 它关联的已确认证据」推导，时长只挑一个压缩预算。生成结果再过一次数字校验，
 *    并把事实集合指纹随口述一起落库——三行的指纹必须相同，事后可查。
 *
 * 3. **删 Story 不删 Evidence**，见 repository.deleteStoryCascade。
 *
 * System Prompt 仍走 T06 组合器的 answerCoaching slot。选这个 slot 不只是因为它
 * 语义对得上：组合器对产出个人事实的 slot 是 fail-closed 的，没有已确认证据时
 * 直接拒绝组合。也就是说即便本模块的检查哪天被绕过，模型也不会开口编。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { CandidateEvidence, SpeechSnippet } from '@core/entities';
import type { LlmRole } from '@core/enums';
import { toPromptEvidenceList } from '@core/evidence/promptEvidence';
import type { InterviewFormatDefinition, RolePack } from '@core/plugins/types';
import { composePrompt, type ComposedPrompt } from '@core/prompts/composer';
import {
  buildStoryFactSet,
  checkDeliveryGrounding,
  readGeneratedDelivery,
  storyDeliveryRepairRequest,
  storyDeliveryRequest,
  StoryError,
  type Story,
  type StoryDeliveryDuration,
  type StoryDeliveryView,
  type StoryInput,
  type StoryPatch,
  type StoryProtocol,
} from '@core/story';
import { PracticeError } from '@core/practice';
import { resolveCampaignPracticeRuntime } from '../practice/rolePack';
import {
  campaignExists,
  deleteStoryCascade,
  findEvidenceByIds,
  getStory,
  insertStory,
  listConfirmedStoryEvidence,
  listDeliveries,
  listStories,
  replaceStoryEvidence,
  updateStoryFields,
  writeDelivery,
  type StoryFields,
} from './repository';

/** 口述与「生成推荐答案」同属一类任务，沿用同一档模型配置 */
const STORY_ROLE: LlmRole = 'quiz';

export interface StoryServiceDeps {
  raw: Database;
  completeJson: <T>(request: {
    role: LlmRole;
    prompt: ComposedPrompt;
    user: string;
    signal?: AbortSignal;
  }) => Promise<T>;
  now?: () => number;
  newId?: () => string;
}

export interface StoryService extends StoryProtocol {
  get(id: string): Story | null;
  list(campaignId: string): Story[];
  listDeliveries(id: string): StoryDeliveryView[];
  remove(id: string): void;
}

/**
 * 挑一个用来生成口述的题型。
 *
 * 按 protocol 找而不是写死 formatId：Story 是行为面试的产物，哪个岗位包都可能
 * 用不同的 id 命名它。找不到就报错停下，不退化成随便用一个题型的话术片段——
 * 拿系统设计的口吻讲一段个人经历，用户一听就知道不是自己会说的话。
 */
export function resolveStoryDeliveryFormat(rolePack: RolePack): InterviewFormatDefinition {
  const coaching = rolePack.promptFragments.answerCoaching ?? {};
  const usable = rolePack.interviewFormats.filter((format) => Boolean(coaching[format.id]));
  const behavioral = usable.find((format) => format.protocol === 'behavioral');
  const chosen = behavioral ?? usable[0];
  if (!chosen) {
    throw new StoryError(
      'no-delivery-format',
      `岗位包 ${rolePack.manifest.id} 没有可用于口述的题型片段`,
    );
  }
  return chosen;
}

/** patch 里给了就用 patch 的，没给就沿用库里那一份 */
function mergedFields(base: Story | null, patch: Partial<StoryInput>): StoryFields {
  return {
    title: (patch.title ?? base?.title ?? '').trim(),
    situationMd: (patch.situationMd ?? base?.situationMd ?? '').trim(),
    taskMd: (patch.taskMd ?? base?.taskMd ?? '').trim(),
    actionMd: (patch.actionMd ?? base?.actionMd ?? '').trim(),
    resultMd: (patch.resultMd ?? base?.resultMd ?? '').trim(),
    reflectionMd: (patch.reflectionMd ?? base?.reflectionMd ?? '').trim(),
    competencyIds: patch.competencyIds ?? base?.competencyIds ?? [],
  };
}

/** 标题加至少一段叙事：只有标题的 Story 压不出任何一档口述 */
function assertStoryReadable(fields: StoryFields): void {
  if (!fields.title) {
    throw new StoryError('empty-story', 'Story 必须有标题');
  }
  const narrative = [
    fields.situationMd,
    fields.taskMd,
    fields.actionMd,
    fields.resultMd,
    fields.reflectionMd,
  ].some((text) => text.length > 0);
  if (!narrative) {
    throw new StoryError('empty-story', 'Story 至少要写一段 STAR 内容');
  }
}

export function createStoryService(deps: StoryServiceDeps): StoryService {
  const { raw } = deps;
  const now = (): number => deps.now?.() ?? Date.now();
  const newId = (): string => deps.newId?.() ?? randomUUID();

  function loadStory(id: string): Story {
    const story = getStory(raw, id);
    if (!story) throw new StoryError('story-not-found', `Story ${id} 不存在`);
    return story;
  }

  /**
   * 逐条校验要关联的证据，返回去重后的 id。
   *
   * 三种都拒：不存在、不是 confirmed、属于另一场备考。第三种最容易被忽略，但它
   * 等于把上一次面试的经历接到这次的岗位上，而两边的证据集合本来就该各自独立。
   */
  function assertLinkable(campaignId: string, evidenceIds: readonly string[]): string[] {
    const unique = [...new Set(evidenceIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) {
      throw new StoryError('missing-evidence', 'Story 至少要关联一条已确认证据');
    }

    const found = new Map<string, CandidateEvidence>(
      findEvidenceByIds(raw, unique).map((item) => [item.id, item]),
    );
    const problems: string[] = [];
    for (const id of unique) {
      const evidence = found.get(id);
      if (!evidence) problems.push(`${id} 不存在`);
      else if (evidence.campaignId !== campaignId) problems.push(`${id} 属于另一场备考`);
      else if (evidence.status !== 'confirmed') problems.push(`${id} 还不是已确认状态`);
    }
    if (problems.length > 0) {
      throw new StoryError(
        'invalid-evidence',
        'Story 只能关联本场备考里已确认的证据',
        problems.join('；'),
      );
    }
    return unique;
  }

  /** 写操作收尾时的不变量：库里不允许留下零条已确认证据的 Story */
  function assertStillGrounded(storyId: string): void {
    if (listConfirmedStoryEvidence(raw, storyId).length === 0) {
      throw new StoryError(
        'missing-evidence',
        `Story ${storyId} 没有任何已确认证据，本次修改不保存`,
      );
    }
  }

  async function create(input: StoryInput): Promise<Story> {
    if (!campaignExists(raw, input.campaignId)) {
      throw new StoryError('campaign-not-found', `备考 ${input.campaignId} 不存在`);
    }
    const fields = mergedFields(null, input);
    assertStoryReadable(fields);
    const evidenceIds = assertLinkable(input.campaignId, input.evidenceIds);

    const id = newId();
    const timestamp = now();
    // 一笔事务：证据关联写不进去时不能留下一条没有事实支撑的 Story
    raw.transaction(() => {
      insertStory(raw, { ...fields, id, campaignId: input.campaignId, now: timestamp });
      replaceStoryEvidence(raw, id, evidenceIds, { now: timestamp, newId });
      assertStillGrounded(id);
    })();

    return loadStory(id);
  }

  async function revise(id: string, patch: StoryPatch): Promise<Story> {
    const existing = loadStory(id);
    const fields = mergedFields(existing, patch);
    assertStoryReadable(fields);
    const evidenceIds =
      patch.evidenceIds === undefined
        ? null
        : assertLinkable(existing.campaignId, patch.evidenceIds);

    const timestamp = now();
    raw.transaction(() => {
      updateStoryFields(raw, id, fields, timestamp);
      if (evidenceIds) replaceStoryEvidence(raw, id, evidenceIds, { now: timestamp, newId });
      // 即使这次没动证据也要重数一遍：关联的证据可能在两次编辑之间被拒掉了，
      // 那一刻这条 Story 已经不成立，不能借着「只改标题」把它留在库里
      assertStillGrounded(id);
    })();

    return loadStory(id);
  }

  /**
   * 生成一个时长档位的口述版本。
   *
   * 事实集合只在这里组装一次，三档共用同一段渲染文本；duration 只影响压缩预算。
   * 校验不通过给模型一次带诊断的重试，仍不通过就抛错、不落库——一个多出来的
   * 指标会被用户当成自己的战绩背下来，面试官追问时对不上，代价比少一份口述大。
   */
  async function createDelivery(
    id: string,
    duration: StoryDeliveryDuration,
  ): Promise<SpeechSnippet> {
    const story = loadStory(id);
    const evidence = listConfirmedStoryEvidence(raw, id);
    if (evidence.length === 0) {
      throw new StoryError(
        'missing-evidence',
        `Story ${id} 关联的证据都已不是已确认状态，不能生成口述`,
      );
    }

    const runtime = resolveRuntime(story.campaignId);
    const format = resolveStoryDeliveryFormat(runtime.rolePack);
    const factSet = buildStoryFactSet(story, evidence);
    const request = storyDeliveryRequest({ factSet, duration });
    const prompt = composePrompt({
      runtime: runtime.descriptor,
      rolePack: runtime.rolePack,
      slot: 'answerCoaching',
      formatId: format.id,
      // 组合器对 answerCoaching 是 fail-closed 的：这里传空数组时它会拒绝组合
      evidence: toPromptEvidenceList(evidence),
      userRequest: request,
      params: { type: 'scenario', language: runtime.interviewLanguage },
    });

    let generated = readGeneratedDelivery(
      await deps.completeJson<unknown>({ role: STORY_ROLE, prompt, user: request }),
    );
    let grounded = checkDeliveryGrounding({ factSet, duration, deliveryMd: generated.deliveryMd });

    if (!grounded.ok) {
      const repair = storyDeliveryRepairRequest(grounded.failure);
      generated = readGeneratedDelivery(
        await deps.completeJson<unknown>({
          role: STORY_ROLE,
          prompt,
          user: `${request}\n\n${repair}`,
        }),
      );
      grounded = checkDeliveryGrounding({ factSet, duration, deliveryMd: generated.deliveryMd });
    }

    if (!grounded.ok) {
      throw new StoryError(
        'ungrounded-delivery',
        '这次口述里有事实集合之外的数字，没有保存',
        grounded.failure.inventedNumbers.join('、'),
      );
    }

    return writeDelivery(
      raw,
      {
        storyId: id,
        duration,
        contentMd: generated.deliveryMd,
        factSetHash: factSet.hash,
        promptVersionId: prompt.provenance.promptVersionId,
      },
      { now: now(), newId },
    );
  }

  /** 运行时解析失败是「这场备考还没绑岗位包」，翻译成 Story 自己的错误码 */
  function resolveRuntime(campaignId: string): ReturnType<typeof resolveCampaignPracticeRuntime> {
    try {
      return resolveCampaignPracticeRuntime(raw, campaignId);
    } catch (error) {
      if (error instanceof PracticeError) {
        throw new StoryError('runtime-unavailable', error.message, error.code);
      }
      throw error;
    }
  }

  return {
    create,
    revise,
    createDelivery,
    get: (id: string) => getStory(raw, id),
    list: (campaignId: string) => listStories(raw, campaignId),
    listDeliveries: (id: string) => listDeliveries(raw, id),
    remove: (id: string) => {
      loadStory(id);
      deleteStoryCascade(raw, id);
    },
  };
}
