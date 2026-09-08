/**
 * story / story_evidence / story_delivery 的取数与写入。
 *
 * 与 evidence、practice 一样接收 raw Database，不引用 ../db：服务层的依赖全部显式
 * 传入，用例才能对着一份真跑过迁移的内存库验完整流程。
 *
 * 口述正文写在 speech_snippet 里，这里直接落库而不复用 src/main/speech——那一份
 * 走 Drizzle 的进程内单例，指不到测试库上。去重规则也不同：话术库按内容去重，
 * 口述版本按「Story + 时长」唯一，重新生成是替换而不是再攒一条。
 */

import type { Database } from 'better-sqlite3';
import type { CandidateEvidence, SpeechSnippet } from '@shared/entities';
import type { Story, StoryDeliveryDuration, StoryDeliveryView } from '@shared/story';
import { rowToEvidence } from '../evidence/repository';

type EvidenceRowShape = Parameters<typeof rowToEvidence>[0];

const EVIDENCE_COLUMNS = `e.id AS id, e.campaign_id AS campaign_id, e.kind AS kind,
                          e.title AS title, e.statement AS statement,
                          e.source_kind AS source_kind,
                          e.source_document_id AS source_document_id,
                          e.source_start AS source_start, e.source_end AS source_end,
                          e.source_text AS source_text, e.occurred_at AS occurred_at,
                          e.confidence AS confidence, e.status AS status,
                          e.created_at AS created_at, e.updated_at AS updated_at`;

interface StoryRow {
  id: string;
  campaign_id: string;
  title: string;
  situation_md: string;
  task_md: string;
  action_md: string;
  result_md: string;
  reflection_md: string;
  competency_ids: string;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  story_id: string;
  snippet_id: string;
  duration_seconds: number;
  fact_set_hash: string;
  prompt_version_id: string;
  created_at: number;
  content_md?: string;
  is_user_edited?: number;
}

const STORY_COLUMNS = `id, campaign_id, title, situation_md, task_md, action_md, result_md,
                       reflection_md, competency_ids, created_at, updated_at`;

function parseIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function rowToStory(raw: Database, row: StoryRow): Story {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    title: row.title,
    situationMd: row.situation_md,
    taskMd: row.task_md,
    actionMd: row.action_md,
    resultMd: row.result_md,
    reflectionMd: row.reflection_md,
    evidenceIds: listStoryEvidenceIds(raw, row.id),
    competencyIds: parseIds(row.competency_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getStory(raw: Database, id: string): Story | null {
  const row = raw.prepare(`SELECT ${STORY_COLUMNS} FROM story WHERE id = ?`).get(id) as
    | StoryRow
    | undefined;
  return row ? rowToStory(raw, row) : null;
}

export function listStories(raw: Database, campaignId: string): Story[] {
  const rows = raw
    .prepare(
      `SELECT ${STORY_COLUMNS} FROM story WHERE campaign_id = ? ORDER BY created_at DESC, id`,
    )
    .all(campaignId) as StoryRow[];
  return rows.map((row) => rowToStory(raw, row));
}

export function campaignExists(raw: Database, campaignId: string): boolean {
  return Boolean(raw.prepare(`SELECT 1 FROM campaign WHERE id = ?`).get(campaignId));
}

export function listStoryEvidenceIds(raw: Database, storyId: string): string[] {
  return (
    raw
      .prepare(`SELECT evidence_id FROM story_evidence WHERE story_id = ? ORDER BY created_at, id`)
      .all(storyId) as Array<{ evidence_id: string }>
  ).map((row) => row.evidence_id);
}

/**
 * 取这个 Story 当前仍然成立的事实来源。
 *
 * 只返回 confirmed：证据可以在 Story 建好之后被拒掉，那一刻这条 Story 就不再有
 * 这份事实支撑了。口述生成读的是这个函数，所以它拿不到被拒过的东西。
 */
export function listConfirmedStoryEvidence(raw: Database, storyId: string): CandidateEvidence[] {
  const rows = raw
    .prepare(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM story_evidence AS se
         JOIN candidate_evidence AS e ON e.id = se.evidence_id
        WHERE se.story_id = ? AND e.status = 'confirmed'
        ORDER BY e.id`,
    )
    .all(storyId) as EvidenceRowShape[];
  return rows.map(rowToEvidence);
}

/** 按 id 取证据，用于写入前逐条校验来源与状态 */
export function findEvidenceByIds(raw: Database, ids: readonly string[]): CandidateEvidence[] {
  if (ids.length === 0) return [];
  const rows = raw
    .prepare(
      `SELECT ${EVIDENCE_COLUMNS} FROM candidate_evidence AS e
        WHERE e.id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as EvidenceRowShape[];
  return rows.map(rowToEvidence);
}

export interface StoryWriteOptions {
  now?: () => number;
  newId?: () => string;
}

export interface StoryFields {
  title: string;
  situationMd: string;
  taskMd: string;
  actionMd: string;
  resultMd: string;
  reflectionMd: string;
  competencyIds: string[];
}

export function insertStory(
  raw: Database,
  input: StoryFields & { id: string; campaignId: string; now: number },
): void {
  raw
    .prepare(
      `INSERT INTO story (
         id, campaign_id, title, situation_md, task_md, action_md, result_md,
         reflection_md, competency_ids, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.campaignId,
      input.title,
      input.situationMd,
      input.taskMd,
      input.actionMd,
      input.resultMd,
      input.reflectionMd,
      JSON.stringify(input.competencyIds),
      input.now,
      input.now,
    );
}

export function updateStoryFields(
  raw: Database,
  id: string,
  fields: StoryFields,
  now: number,
): void {
  raw
    .prepare(
      `UPDATE story
          SET title = ?, situation_md = ?, task_md = ?, action_md = ?, result_md = ?,
              reflection_md = ?, competency_ids = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      fields.title,
      fields.situationMd,
      fields.taskMd,
      fields.actionMd,
      fields.resultMd,
      fields.reflectionMd,
      JSON.stringify(fields.competencyIds),
      now,
      id,
    );
}

/** 整组替换关联证据。多余的链接删掉，已有的保留原 created_at 以稳定展示顺序 */
export function replaceStoryEvidence(
  raw: Database,
  storyId: string,
  evidenceIds: readonly string[],
  options: { now: number; newId: () => string },
): void {
  const keep = new Set(evidenceIds);
  for (const existing of listStoryEvidenceIds(raw, storyId)) {
    if (!keep.has(existing)) {
      raw
        .prepare(`DELETE FROM story_evidence WHERE story_id = ? AND evidence_id = ?`)
        .run(storyId, existing);
    }
  }
  for (const evidenceId of evidenceIds) {
    raw
      .prepare(
        `INSERT INTO story_evidence (id, story_id, evidence_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (story_id, evidence_id) DO NOTHING`,
      )
      .run(options.newId(), storyId, evidenceId, options.now);
  }
}

export interface DeliveryWriteInput {
  storyId: string;
  duration: StoryDeliveryDuration;
  contentMd: string;
  factSetHash: string;
  promptVersionId: string;
}

/**
 * 落一个口述版本：先清掉这一档的旧行，再写新的正文与元数据。
 *
 * 删旧话术是替换语义的一部分——同一档留两条内容不同的口述，用户面试前会不知道
 * 该背哪一条。
 */
export function writeDelivery(
  raw: Database,
  input: DeliveryWriteInput,
  options: { now: number; newId: () => string },
): SpeechSnippet {
  const previous = raw
    .prepare(`SELECT snippet_id FROM story_delivery WHERE story_id = ? AND duration_seconds = ?`)
    .get(input.storyId, input.duration) as { snippet_id: string } | undefined;
  if (previous) {
    // speech_snippet 上有外键，删正文时 story_delivery 那一行跟着走
    raw.prepare(`DELETE FROM speech_snippet WHERE id = ?`).run(previous.snippet_id);
  }

  const snippet: SpeechSnippet = {
    id: options.newId(),
    sourceType: 'story',
    sourceId: input.storyId,
    tier: 'spoken',
    contentMd: input.contentMd,
    isUserEdited: false,
    createdAt: options.now,
  };
  raw
    .prepare(
      `INSERT INTO speech_snippet (
         id, source_type, source_id, tier, content_md, is_user_edited, created_at
       ) VALUES (?, 'story', ?, 'spoken', ?, 0, ?)`,
    )
    .run(snippet.id, input.storyId, snippet.contentMd, snippet.createdAt);
  raw
    .prepare(
      `INSERT INTO story_delivery (
         id, story_id, snippet_id, duration_seconds, fact_set_hash, prompt_version_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.newId(),
      input.storyId,
      snippet.id,
      input.duration,
      input.factSetHash,
      input.promptVersionId,
      options.now,
    );

  return snippet;
}

export function listDeliveries(raw: Database, storyId: string): StoryDeliveryView[] {
  const rows = raw
    .prepare(
      `SELECT d.id AS id, d.story_id AS story_id, d.snippet_id AS snippet_id,
              d.duration_seconds AS duration_seconds, d.fact_set_hash AS fact_set_hash,
              d.prompt_version_id AS prompt_version_id, d.created_at AS created_at,
              s.content_md AS content_md, s.is_user_edited AS is_user_edited
         FROM story_delivery AS d
         JOIN speech_snippet AS s ON s.id = d.snippet_id
        WHERE d.story_id = ?
        ORDER BY d.duration_seconds`,
    )
    .all(storyId) as DeliveryRow[];
  return rows.map((row) => ({
    id: row.id,
    storyId: row.story_id,
    snippetId: row.snippet_id,
    durationSeconds: row.duration_seconds as StoryDeliveryDuration,
    factSetHash: row.fact_set_hash,
    promptVersionId: row.prompt_version_id,
    createdAt: row.created_at,
    contentMd: row.content_md ?? '',
    isUserEdited: Boolean(row.is_user_edited),
  }));
}

/**
 * 删掉一个 Story 及其派生物。
 *
 * 明确不碰 candidate_evidence：Story 是「这段经历怎么讲」，证据是「我做过什么」。
 * 讲法可以推翻重写，做过的事不会因此消失，而且同一条证据往往还挂在别的 Story
 * 和别的题目上。
 *
 * 口述话术反过来必须跟着删：它的全部意义就是「这个 Story 压到 N 秒」，Story 没了
 * 之后它既显示不出来源、也追不回任何一条证据——那正是写入时被 fail-closed 挡住的
 * 状态，不该由删除操作制造出来。
 */
export function deleteStoryCascade(raw: Database, storyId: string): void {
  raw
    .prepare(`DELETE FROM speech_snippet WHERE source_type = 'story' AND source_id = ?`)
    .run(storyId);
  raw.prepare(`DELETE FROM story WHERE id = ?`).run(storyId);
}
