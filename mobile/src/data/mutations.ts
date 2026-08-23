import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { TaskView } from '@shared/ipc';
import type { ExplanationTier } from '@shared/enums';
import type { FollowUpSummaryUpdate } from '@shared/llm/followUpContext';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

export type FollowUpMessage = { role: 'user' | 'assistant'; text: string };

function legacyFollowUpKey(nodeId: string): string {
  return `ui.followUpHistory.${nodeId}`;
}

async function ensureFollowUpSession(
  db: SQLiteDatabase,
  campaignId: string,
  nodeId: string,
  nodeName: string,
): Promise<string> {
  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM session
     WHERE node_id = ? AND kind = 'nodeFollowUp'
     ORDER BY created_at DESC LIMIT 1`,
    nodeId,
  );
  if (existing) return existing.id;

  const identity = await getDeviceIdentity(db);
  // 两端离线首次发问时也生成同一个会话 ID，后续同步会自然汇合。
  const id = `node-follow-up:${nodeId}`;
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO session (id, campaign_id, node_id, kind, title, created_at)
       VALUES (?, ?, ?, 'nodeFollowUp', ?, ?)`,
      id,
      campaignId,
      nodeId,
      nodeName,
      Date.now(),
    );
  });
  return id;
}

export async function migrateLegacyFollowUpHistory(
  db: SQLiteDatabase,
  campaignId: string,
  nodeId: string,
  nodeName: string,
): Promise<void> {
  const legacy = db.getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key = ?`,
    legacyFollowUpKey(nodeId),
  );
  if (!legacy?.value) return;

  let messages: FollowUpMessage[];
  try {
    messages = (JSON.parse(legacy.value) as FollowUpMessage[]).filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string',
    );
  } catch {
    return;
  }
  if (messages.length === 0) return;

  const sessionId = await ensureFollowUpSession(db, campaignId, nodeId, nodeName);
  const identity = await getDeviceIdentity(db);
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    messages.forEach((message, index) => {
      db.runSync(
        `INSERT INTO message (id, session_id, role, content_md, citations, created_at)
         VALUES (?, ?, ?, ?, '[]', ?)`,
        Crypto.randomUUID(),
        sessionId,
        message.role,
        message.text,
        now + index,
      );
    });
    db.runSync(`DELETE FROM sync_meta WHERE key = ?`, legacyFollowUpKey(nodeId));
  });
}

export async function appendFollowUpMessage(
  db: SQLiteDatabase,
  campaignId: string,
  nodeId: string,
  nodeName: string,
  message: FollowUpMessage,
): Promise<void> {
  const sessionId = await ensureFollowUpSession(db, campaignId, nodeId, nodeName);
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO message (id, session_id, role, content_md, citations, created_at)
       VALUES (?, ?, ?, ?, '[]', ?)`,
      Crypto.randomUUID(),
      sessionId,
      message.role,
      message.text,
      Date.now(),
    );
  });
}

export async function deleteFollowUpHistory(
  db: SQLiteDatabase,
  nodeId: string,
): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `DELETE FROM session WHERE node_id = ? AND kind = 'nodeFollowUp'`,
      nodeId,
    );
    db.runSync(`DELETE FROM sync_meta WHERE key = ?`, legacyFollowUpKey(nodeId));
  });
}

export async function updateFollowUpSummary(
  db: SQLiteDatabase,
  sessionId: string,
  update: FollowUpSummaryUpdate,
): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE session
       SET context_summary_md = ?,
           context_summary_through_id = ?,
           context_summary_source_count = ?
       WHERE id = ?`,
      update.summary,
      update.throughMessageId,
      update.sourceCount,
      sessionId,
    );
  });
}

function taskView(db: SQLiteDatabase, taskId: string): TaskView {
  const t = db.getFirstSync<{
    id: string;
    plan_day_id: string;
    node_id: string | null;
    repo_id: string | null;
    kind: string;
    est_minutes: number;
    actual_minutes: number | null;
    status: string;
    order_idx: number;
  }>(`SELECT * FROM task WHERE id = ?`, taskId);
  if (!t) throw new Error('任务不存在');
  const node = t.node_id
    ? db.getFirstSync<{ name: string; coverage_type: string }>(
        `SELECT name, coverage_type FROM knowledge_node WHERE id = ?`,
        t.node_id,
      )
    : null;
  const repo = t.repo_id
    ? db.getFirstSync<{ url: string }>(`SELECT url FROM repo WHERE id = ?`, t.repo_id)
    : null;
  return {
    id: t.id,
    planDayId: t.plan_day_id,
    nodeId: t.node_id,
    repoId: t.repo_id,
    kind: t.kind as TaskView['kind'],
    estMinutes: t.est_minutes,
    actualMinutes: t.actual_minutes,
    status: t.status as TaskView['status'],
    orderIdx: t.order_idx,
    nodeName: node?.name ?? null,
    nodeCoverage: (node?.coverage_type as TaskView['nodeCoverage']) ?? null,
    repoUrl: repo?.url ?? null,
  };
}

export async function completeTask(
  db: SQLiteDatabase,
  taskId: string,
  actualMinutes?: number,
): Promise<TaskView> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    const row = db.getFirstSync<{ est_minutes: number; node_id: string | null; kind: string }>(
      `SELECT est_minutes, node_id, kind FROM task WHERE id = ?`,
      taskId,
    );
    if (!row) throw new Error('任务不存在');
    db.runSync(
      `UPDATE task SET status = 'done', actual_minutes = ? WHERE id = ?`,
      actualMinutes ?? row.est_minutes,
      taskId,
    );
    if (row.node_id && row.kind === 'learn') {
      db.runSync(`UPDATE knowledge_node SET status = 'learning' WHERE id = ?`, row.node_id);
    }
  });
  return taskView(db, taskId);
}

export async function skipTask(db: SQLiteDatabase, taskId: string): Promise<TaskView> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(`UPDATE task SET status = 'skipped' WHERE id = ?`, taskId);
  });
  return taskView(db, taskId);
}

export async function updateSpeech(db: SQLiteDatabase, id: string, contentMd: string): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `UPDATE speech_snippet SET content_md = ?, is_user_edited = 1 WHERE id = ?`,
      contentMd,
      id,
    );
  });
}

export async function deleteSpeech(db: SQLiteDatabase, id: string): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(`DELETE FROM speech_snippet WHERE id = ?`, id);
  });
}

export async function saveSpeechFromNode(
  db: SQLiteDatabase,
  nodeId: string,
  contentMd: string,
  tier: ExplanationTier,
): Promise<{ id: string; existing: boolean }> {
  const trimmed = contentMd.trim();
  if (!trimmed) throw new Error('话术内容为空');

  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM speech_snippet
     WHERE source_type = 'node' AND source_id = ? AND content_md = ?
     LIMIT 1`,
    nodeId,
    trimmed,
  );
  if (existing) return { id: existing.id, existing: true };

  const identity = await getDeviceIdentity(db);
  const id = Crypto.randomUUID();
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, is_user_edited, created_at)
       VALUES (?, 'node', ?, ?, ?, 0, ?)`,
      id,
      nodeId,
      tier,
      trimmed,
      now,
    );
  });
  return { id, existing: false };
}

/**
 * 手动存考我的推荐答案。挂在考点而不是作答上：题目可以在提交之前就存，
 * 而且同一个考点反复练出的同一段话术会被去重合成一条。
 */
export async function saveSpeechFromQuizNode(
  db: SQLiteDatabase,
  nodeId: string,
  contentMd: string,
): Promise<{ id: string; existing: boolean }> {
  const trimmed = contentMd.trim();
  if (!trimmed) throw new Error('话术内容为空');

  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM speech_snippet
     WHERE source_type = 'quiz' AND source_id = ? AND content_md = ?
     LIMIT 1`,
    nodeId,
    trimmed,
  );
  if (existing) return { id: existing.id, existing: true };

  const identity = await getDeviceIdentity(db);
  const id = Crypto.randomUUID();
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, is_user_edited, created_at)
       VALUES (?, 'quiz', ?, 'spoken', ?, 0, ?)`,
      id,
      nodeId,
      trimmed,
      now,
    );
  });
  return { id, existing: false };
}

export async function saveSpeechFromDesign(
  db: SQLiteDatabase,
  campaignId: string,
  contentMd: string,
): Promise<{ id: string; existing: boolean }> {
  const trimmed = contentMd.trim();
  if (!trimmed) throw new Error('话术内容为空');

  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM speech_snippet
     WHERE source_type = 'design' AND source_id = ? AND content_md = ?
     LIMIT 1`,
    campaignId,
    trimmed,
  );
  if (existing) return { id: existing.id, existing: true };

  const identity = await getDeviceIdentity(db);
  const id = Crypto.randomUUID();
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO speech_snippet (id, source_type, source_id, tier, content_md, is_user_edited, created_at)
       VALUES (?, 'design', ?, 'spoken', ?, 0, ?)`,
      id,
      campaignId,
      trimmed,
      now,
    );
  });
  return { id, existing: false };
}

export async function createCampaign(
  db: SQLiteDatabase,
  company: string,
  roleTitle: string,
  jdRaw: string,
): Promise<string> {
  const identity = await getDeviceIdentity(db);
  const id = Crypto.randomUUID();
  const now = Date.now();
  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planning', ?, ?)`,
      id,
      company.trim(),
      roleTitle.trim(),
      jdRaw.trim(),
      now,
      now,
    );
  });
  return id;
}

export async function deleteCampaign(db: SQLiteDatabase, id: string): Promise<void> {
  const identity = await getDeviceIdentity(db);
  writingAs(db, identity.deviceId, () => {
    db.runSync(`DELETE FROM campaign WHERE id = ?`, id);
  });
}
