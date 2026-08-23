import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { dialog } from 'electron';
import type { ExplanationTier } from '@shared/enums';
import type { SpeechSnippet } from '@shared/entities';
import type { SpeechExportInput, SpeechExportResult, SpeechSnippetView } from '@shared/ipc';
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

function resolveSourceLabel(sourceType: SpeechSnippet['sourceType'], sourceId: string): string {
  const db = getDb();
  if (sourceType === 'codeRef') {
    const repo = db.select().from(schema.repo).where(eq(schema.repo.id, sourceId)).get();
    return repo ? `源码 · ${repo.url.replace(/^https?:\/\//, '')}` : '源码';
  }
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
  if (sourceType === 'design') {
    const campaign = db
      .select()
      .from(schema.campaign)
      .where(eq(schema.campaign.id, sourceId))
      .get();
    return campaign ? `模拟面试 · ${campaign.company}` : '模拟面试';
  }
  return '话术';
}

export function listSpeechSnippets(): SpeechSnippetView[] {
  const rows = getDb().select().from(schema.speechSnippet).all();
  return rows
    .map((row) => ({
      ...rowToSnippet(row),
      sourceLabel: resolveSourceLabel(row.sourceType, row.sourceId),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function saveSpeechFromRepo(
  repoId: string,
  contentMd: string,
  tier: ExplanationTier = 'spoken',
): SpeechSnippet {
  return saveSpeech('codeRef', repoId, contentMd, tier);
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

export function saveSpeechFromDesign(
  campaignId: string,
  _caseTitle: string,
  contentMd: string,
): SpeechSnippet {
  return saveSpeech('design', campaignId, contentMd, 'spoken');
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
