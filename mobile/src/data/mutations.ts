import type { SQLiteDatabase } from 'expo-sqlite';
import type { TaskView } from '@shared/ipc';
import { v4 as uuidv4 } from 'uuid';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

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

export async function createCampaign(
  db: SQLiteDatabase,
  company: string,
  roleTitle: string,
  jdRaw: string,
): Promise<string> {
  const identity = await getDeviceIdentity(db);
  const id = uuidv4();
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
