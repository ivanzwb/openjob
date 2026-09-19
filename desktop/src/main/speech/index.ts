import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { dialog } from 'electron';
import type { ExplanationTier } from '@core/enums';
import type { SpeechSnippet } from '@core/entities';
import type { SpeechExportInput, SpeechExportResult, SpeechSnippetView } from '@core/ipc';
import type { LibrarySnippet } from '@core/plugins/pluginRuntime/host';
import { getDb, schema } from '../db';
import { writeSpeechPdf } from './pdf';

function rowToSnippet(row: typeof schema.speechSnippet.$inferSelect): SpeechSnippet {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    tier: row.tier,
    contentMd: row.contentMd,
    isUserEdited: row.isUserEdited,
    createdAt: row.createdAt,
  };
}

function resolveSourceLabel(
  sourceType: SpeechSnippet['sourceType'],
  sourceId: string,
  campaignId: string | null = null,
): string {
  const db = getDb();
  if (sourceType === 'node') {
    const node = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, sourceId))
      .get();
    return node ? `考点 · ${node.name}` : '考点';
  }
  if (sourceType === 'quiz') {
    // 评分后自动存的那条挂在这次作答上，手动存的推荐答案挂在考点上
    // （出题时还没有作答记录），两种 id 都要能认出来。
    const attempt = db
      .select()
      .from(schema.quizAttempt)
      .where(eq(schema.quizAttempt.id, sourceId))
      .get();
    const nodeId = attempt?.nodeId ?? sourceId;
    const node = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, nodeId))
      .get();
    return node ? `考我 · ${node.name}` : '考我';
  }
  if (sourceType === 'story') {
    // 标题用 Story 自己的标题而不是时长档位：用户找的是「哪一段经历」，
    // 三档口述在详情里再分。
    const row = db.select().from(schema.story).where(eq(schema.story.id, sourceId)).get();
    return row ? `经历 · ${row.title}` : '经历';
  }
  // 宿主不认识这个来源取值：它可能是包自己起的 sourceKind（如 code-ref），包把可读的
  // 来源标签（file:line）存进了 source_id——这里直接用存下来的标签渲染，而不是硬编码一个
  // 中性词，「已存入话术库」与全局话术库里都据此显示来源。
  // 历史/未知取值照常展示，绝不因为来源取值认不出而被丢掉或抛错：那些行的 source_id 是
  // 一场备考（插件化之前的岗位簇链路写的），不是标签，仍回中性兜底。
  if (campaignId !== null) return '话术';
  return sourceId || '话术';
}

/**
 * 话术 → 备考（JD）的追溯：一条话术最终挂在哪次备考上。
 * - node：knowledgeNode.campaignId
 * - quiz：挂在作答或考点上，两种 id 都要能认出来，再经 node 取 campaignId
 * - story：story.campaignId
 * - 未知/历史来源：插件化之前那条链路把 campaignId 直接存进 source_id，这里不按
 *   来源取值分支，改看 source_id 本身是不是一场备考；认不出就返回 null
 */
function resolveCampaign(
  sourceType: SpeechSnippet['sourceType'],
  sourceId: string,
): { campaignId: string; label: string } | null {
  const db = getDb();
  let campaignId: string | null;

  if (sourceType === 'node') {
    const node = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, sourceId))
      .get();
    campaignId = node?.campaignId ?? null;
  } else if (sourceType === 'quiz') {
    const attempt = db
      .select()
      .from(schema.quizAttempt)
      .where(eq(schema.quizAttempt.id, sourceId))
      .get();
    const nodeId = attempt?.nodeId ?? sourceId;
    const node = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, nodeId))
      .get();
    campaignId = node?.campaignId ?? null;
  } else if (sourceType === 'story') {
    const row = db.select().from(schema.story).where(eq(schema.story.id, sourceId)).get();
    campaignId = row?.campaignId ?? null;
  } else {
    // 未知/历史来源按备考表的形状兜底：source_id 直接指一场备考时归到它名下，
    // 指不到任何备考（如已下线的源码话术）就老实返回 null。
    const campaign = db
      .select()
      .from(schema.campaign)
      .where(eq(schema.campaign.id, sourceId))
      .get();
    campaignId = campaign?.id ?? null;
  }

  if (!campaignId) return null;

  const campaign = db
    .select()
    .from(schema.campaign)
    .where(eq(schema.campaign.id, campaignId))
    .get();
  if (!campaign) return null;
  return { campaignId: campaign.id, label: `${campaign.company} · ${campaign.roleTitle}` };
}

export function listSpeechSnippets(): SpeechSnippetView[] {
  const rows = getDb().select().from(schema.speechSnippet).all();
  return rows
    .map((row) => {
      const campaign = resolveCampaign(row.sourceType, row.sourceId);
      return {
        ...rowToSnippet(row),
        sourceLabel: resolveSourceLabel(row.sourceType, row.sourceId, campaign?.campaignId ?? null),
        campaignId: campaign?.campaignId ?? null,
        campaignLabel: campaign?.label ?? null,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function saveSpeechFromQuiz(
  _nodeId: string,
  attemptId: string,
  contentMd: string,
): SpeechSnippet {
  return saveSpeech('quiz', attemptId, contentMd, 'spoken');
}

/**
 * 手动存考我的推荐答案。挂在考点而不是作答上：题目可以在提交之前就存，
 * 而且同一个考点反复练出的同一段话术会被去重合成一条。
 */
export function saveSpeechFromQuizNode(nodeId: string, contentMd: string): SpeechSnippet {
  const text = contentMd.trim();
  if (!text) throw new Error('话术内容为空');
  return saveSpeech('quiz', nodeId, text, 'spoken');
}

export function saveSpeechFromNode(
  nodeId: string,
  contentMd: string,
  tier: ExplanationTier = 'spoken',
): SpeechSnippet {
  return saveSpeech('node', nodeId, contentMd, tier);
}

/** 同一来源下内容一模一样的话术只留一条：要背的是内容，重复条目只会碍事 */
function findSameSnippet(
  sourceType: SpeechSnippet['sourceType'],
  sourceId: string,
  contentMd: string,
): SpeechSnippet | undefined {
  const text = contentMd.trim();
  if (!text) return undefined;
  return listSpeechSnippetsForSource(sourceType, sourceId).find(
    (s) => s.contentMd.trim() === text,
  );
}

export function listSpeechSnippetsForSource(
  sourceType: SpeechSnippet['sourceType'],
  sourceId: string,
): SpeechSnippet[] {
  return getDb()
    .select()
    .from(schema.speechSnippet)
    .where(
      and(
        eq(schema.speechSnippet.sourceType, sourceType),
        eq(schema.speechSnippet.sourceId, sourceId),
      ),
    )
    .all()
    .map(rowToSnippet)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 把包页整理的一段文字存进**用户的话术库**（`library` 原语）。
 *
 * 宿主把包自己起的 `sourceKind` 原样写进 `source_type`（一列裸 text，读取侧对认不出的
 * 取值走中性兜底），把包算出的可读 `sourceLabel` 存进既有的来源标签机制（`source_id`）
 * ——宿主不认识这两个值的语义，也不为某个岗位开专用字段。去重沿用同一套：同来源同内容
 * 只留一条，包页反复点「存为话术」不会堆重复条目。
 */
export function saveLibrarySnippet(
  sourceKind: string,
  sourceLabel: string,
  contentMd: string,
  tier: ExplanationTier = 'spoken',
): LibrarySnippet {
  const text = contentMd.trim();
  if (!text) throw new Error('话术内容为空');
  const kind = sourceKind.trim();
  if (!kind) throw new Error('话术来源类型为空');
  const label = sourceLabel.trim() || kind;
  const snippet = saveSpeech(kind as SpeechSnippet['sourceType'], label, text, tier);
  return { id: snippet.id, text: snippet.contentMd, label, createdAt: snippet.createdAt };
}

/**
 * 取回用户话术库里包自己那一类来源（`sourceKind`）的片段；不传则取全部。
 *
 * 只回包需要显示的四项（正文 / 来源标签 / 时间 / id），并按时间倒序、按上限收窄——
 * 包页据此显示「已存入话术库」并列表，看不见宿主自己那些来源的话术。
 */
export function listLibrarySnippets(sourceKind?: string, limit = 500): LibrarySnippet[] {
  const all = listSpeechSnippets();
  const scoped = sourceKind === undefined ? all : all.filter((s) => s.sourceType === sourceKind);
  return scoped.slice(0, Math.max(0, limit)).map((s) => ({
    id: s.id,
    text: s.contentMd,
    label: s.sourceLabel,
    createdAt: s.createdAt,
  }));
}

function saveSpeech(
  sourceType: SpeechSnippet['sourceType'],
  sourceId: string,
  contentMd: string,
  tier: ExplanationTier,
): SpeechSnippet {
  const same = findSameSnippet(sourceType, sourceId, contentMd);
  if (same) return same;

  const id = randomUUID();
  const now = Date.now();
  const row = {
    id,
    sourceType,
    sourceId,
    tier,
    contentMd,
    isUserEdited: false,
    createdAt: now,
  };
  getDb().insert(schema.speechSnippet).values(row).run();
  return row;
}

export function updateSpeechSnippet(
  id: string,
  contentMd: string,
  isUserEdited = true,
): SpeechSnippet {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.speechSnippet)
    .where(eq(schema.speechSnippet.id, id))
    .get();
  if (!existing) throw new Error('话术不存在');

  db.update(schema.speechSnippet)
    .set({ contentMd, isUserEdited })
    .where(eq(schema.speechSnippet.id, id))
    .run();

  return rowToSnippet({ ...existing, contentMd, isUserEdited });
}

export function deleteSpeechSnippet(id: string): void {
  getDb().delete(schema.speechSnippet).where(eq(schema.speechSnippet.id, id)).run();
}

function buildMarkdownExport(snippets: SpeechSnippetView[]): string {
  const lines = ['# OpenJob 话术库', '', `导出时间：${new Date().toLocaleString()}`, ''];
  for (const s of snippets) {
    lines.push(`## ${s.sourceLabel}`, '', s.contentMd, '', '---', '');
  }
  return lines.join('\n');
}

function buildAnkiExport(snippets: SpeechSnippetView[]): string {
  const lines: string[] = [];
  for (const s of snippets) {
    const front = s.sourceLabel.replace(/\t/g, ' ');
    const back = s.contentMd.replace(/\t/g, ' ').replace(/\n/g, '<br>');
    lines.push(`${front}\t${back}`);
  }
  return lines.join('\n');
}

export async function exportSpeechSnippets(
  input: SpeechExportInput,
): Promise<SpeechExportResult> {
  const all = listSpeechSnippets();
  const snippets = input.ids?.length
    ? all.filter((s) => input.ids!.includes(s.id))
    : all;

  if (snippets.length === 0) {
    return { saved: false, path: null, count: 0 };
  }

  const ext = input.format === 'anki' ? 'txt' : input.format === 'pdf' ? 'pdf' : 'md';
  const defaultName = `openjob-scripts-${Date.now()}.${ext}`;
  const filterName =
    input.format === 'anki' ? 'Anki TSV' : input.format === 'pdf' ? 'PDF' : 'Markdown';

  const filePath = dialog.showSaveDialogSync({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [ext] }],
  });

  if (!filePath) {
    return { saved: false, path: null, count: snippets.length };
  }

  if (input.format === 'pdf') {
    await writeSpeechPdf(snippets, filePath);
    return { saved: true, path: filePath, count: snippets.length };
  }

  const content =
    input.format === 'anki' ? buildAnkiExport(snippets) : buildMarkdownExport(snippets);
  writeFileSync(filePath, content, 'utf8');
  return { saved: true, path: filePath, count: snippets.length };
}
