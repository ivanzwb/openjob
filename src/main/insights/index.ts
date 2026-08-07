import { eq, inArray } from 'drizzle-orm';
import type { HistorySignalResult, Nudge } from '@shared/ipc';
import { getDb, schema } from '../db';
import { getCampaignRow, refreshAllPriorities, rowToNode } from '../campaign/repository';
import { computePriority } from '../diagnosis/priority';

const STALLED_DAYS = 3;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const then = new Date(y!, m! - 1, d!).getTime();
  const [ty, tm, td] = today().split('-').map(Number);
  const now = new Date(ty!, tm! - 1, td!).getTime();
  return Math.round((now - then) / 86_400_000);
}

function campaignNodes(campaignId: string): Array<typeof schema.knowledgeNode.$inferSelect> {
  return getDb()
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();
}

/** 用户消息里提到过某考点几次——反复问什么，就是哪里心里没底 */
function askCounts(campaignId: string, nodeNames: string[]): Map<string, number> {
  const db = getDb();
  const sessions = db.select().from(schema.session).all();
  const relevant = sessions.filter((s) => s.campaignId === campaignId || s.campaignId === null);
  const counts = new Map<string, number>();
  if (relevant.length === 0) return counts;

  const texts = db
    .select()
    .from(schema.message)
    .where(
      inArray(
        schema.message.sessionId,
        relevant.map((s) => s.id),
      ),
    )
    .all()
    .filter((m) => m.role === 'user')
    .map((m) => m.contentMd.toLowerCase());

  for (const name of nodeNames) {
    const needle = name.trim().toLowerCase();
    if (needle.length < 2) continue;
    const n = texts.filter((t) => t.includes(needle)).length;
    if (n > 0) counts.set(name, n);
  }
  return counts;
}

/** 同一考点连续低分的次数 */
function repeatedMisses(nodeIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (nodeIds.length === 0) return out;

  const attempts = getDb()
    .select()
    .from(schema.quizAttempt)
    .where(inArray(schema.quizAttempt.nodeId, nodeIds))
    .all();

  for (const a of attempts) {
    if (a.score > 2) continue;
    out.set(a.nodeId, (out.get(a.nodeId) ?? 0) + 1);
  }
  return out;
}

/** 过了日子还挂着 pending 的任务，按考点归集 */
function stalledTasks(campaignId: string): Array<{ nodeId: string | null; days: number }> {
  const db = getDb();
  const days = db
    .select()
    .from(schema.planDay)
    .where(eq(schema.planDay.campaignId, campaignId))
    .all()
    .filter((d) => d.date < today());
  if (days.length === 0) return [];

  const dayById = new Map(days.map((d) => [d.id, d.date]));
  return db
    .select()
    .from(schema.task)
    .where(
      inArray(
        schema.task.planDayId,
        days.map((d) => d.id),
      ),
    )
    .all()
    .filter((t) => t.status === 'pending')
    .map((t) => ({ nodeId: t.nodeId, days: daysAgo(dayById.get(t.planDayId)!) }))
    .filter((t) => t.days >= STALLED_DAYS);
}

/**
 * 主动提示。设计里点名的三类：长期未动的盲区、反复答错的点、
 * 简历写了但一直没准备的雷区；再加上拖延任务和反复提问两类历史信号。
 */
export function getCampaignNudges(campaignId: string): Nudge[] {
  const nodes = campaignNodes(campaignId);
  if (nodes.length === 0) return [];

  const out: Nudge[] = [];
  const nodeIds = nodes.map((n) => n.id);
  const misses = repeatedMisses(nodeIds);
  const asks = askCounts(campaignId, nodes.map((n) => n.name));
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));

  for (const n of nodes) {
    if (n.kind === 'domain') continue;

    // 盲区来自真题，是图谱预测失败处，信息价值最高
    if (n.coverageType === 'landmine' && n.isUserAdded && n.mastery === 0) {
      out.push({
        kind: 'blindSpot',
        severity: 'high',
        nodeId: n.id,
        title: `盲区未动：${n.name}`,
        detail: '真题里出现过但图谱没预测到，掌握度仍为 0',
      });
      continue;
    }

    if (n.coverageType === 'landmine' && n.status === 'todo') {
      out.push({
        kind: 'unpreparedLandmine',
        severity: 'medium',
        nodeId: n.id,
        title: `雷区没准备：${n.name}`,
        detail: '简历写了但 JD 没提，面试官手里拿的是你的简历',
      });
    }
  }

  for (const [nodeId, count] of misses) {
    if (count < 2) continue;
    out.push({
      kind: 'repeatedMiss',
      severity: 'high',
      nodeId,
      title: `反复答错：${nameById.get(nodeId) ?? nodeId}`,
      detail: `已有 ${count} 次答题得分 ≤ 2`,
    });
  }

  const stalledByNode = new Map<string, number>();
  for (const t of stalledTasks(campaignId)) {
    if (!t.nodeId) continue;
    stalledByNode.set(t.nodeId, Math.max(stalledByNode.get(t.nodeId) ?? 0, t.days));
  }
  for (const [nodeId, days] of stalledByNode) {
    out.push({
      kind: 'stalledTask',
      severity: days >= 7 ? 'high' : 'low',
      nodeId,
      title: `拖了 ${days} 天：${nameById.get(nodeId) ?? nodeId}`,
      detail: '任务过期未完成，可以考虑顺延或拆小',
    });
  }

  for (const [name, count] of asks) {
    if (count < 3) continue;
    const node = nodes.find((n) => n.name === name);
    if (!node || node.mastery >= 3) continue;
    out.push({
      kind: 'askedOften',
      severity: 'medium',
      nodeId: node.id,
      title: `反复追问：${name}`,
      detail: `对话里问了 ${count} 次，掌握度仍只有 ${node.mastery.toFixed(1)}`,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 12);
}

/**
 * 历史即传感器：把「反复问」「反复答错」「一直拖」三类行为回写成排序输入。
 *
 * 显式触发而非自动跑，因为它会改动 examProb 和 estMinutes，
 * 用户需要知道排序为什么变了。
 */
export function applyHistorySignals(campaignId: string): HistorySignalResult {
  getCampaignRow(campaignId);
  const db = getDb();
  const nodes = campaignNodes(campaignId);
  const nodeIds = nodes.map((n) => n.id);
  const misses = repeatedMisses(nodeIds);
  const asks = askCounts(campaignId, nodes.map((n) => n.name));

  const stalledByNode = new Map<string, number>();
  for (const t of stalledTasks(campaignId)) {
    if (!t.nodeId) continue;
    stalledByNode.set(t.nodeId, Math.max(stalledByNode.get(t.nodeId) ?? 0, t.days));
  }

  let boosted = 0;
  let eased = 0;

  for (const row of nodes) {
    const askCount = asks.get(row.name) ?? 0;
    const missCount = misses.get(row.id) ?? 0;
    const stalledDays = stalledByNode.get(row.id) ?? 0;

    let examProb = row.examProb;
    let estMinutes = row.estMinutes;
    let changed = false;

    // 反复问 + 反复答错 = 薄弱区，提高考察权重让它排到前面
    if (askCount >= 3 || missCount >= 2) {
      const next = Math.min(0.95, examProb + 0.05 * Math.min(3, askCount + missCount));
      if (next > examProb) {
        examProb = next;
        changed = true;
        boosted++;
      }
    }

    // 一直拖着不做，多半是单块太大，拆小重排比反复提醒有用
    if (stalledDays >= STALLED_DAYS && estMinutes > 15) {
      estMinutes = Math.max(15, Math.round(estMinutes * 0.7));
      changed = true;
      eased++;
    }

    if (!changed) continue;

    const node = rowToNode({ ...row, examProb, estMinutes });
    const { score } = computePriority(node);
    db.update(schema.knowledgeNode)
      .set({ examProb, estMinutes, priorityScore: score })
      .where(eq(schema.knowledgeNode.id, row.id))
      .run();
  }

  refreshAllPriorities(campaignId);
  return { boosted, eased, nudges: getCampaignNudges(campaignId) };
}
