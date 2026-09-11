/**
 * 手机端面后复盘：口述或打字记下刚面完的内容，就地抽题、匹配考点、修正图谱。
 *
 * 为什么这条链路必须在手机上闭环：复盘的价值随时间衰减得极快。刚出面试间那几分钟里
 * 还记得考官追问的第三层，等晚上回到电脑前只剩「问了 Kafka」。所以这里不做「先记一段
 * 文字、回桌面端再摄入」的折中——抽题、建盲区、抬概率全部本地跑完，写进同步表，桌面端
 * 下次同步就能看到同一份结果。
 *
 * 判定规则一律取自 @core/diagnosis/reportIngest，与桌面端 src/main/diagnosis/ingest.ts
 * 共用一份：可信度权重、概率抬升幅度、多源交叉验证的判重口径、盲区节点的固定字段。
 * 这几个数一旦两端各写一套，同一场备考在手机和电脑上就会排出不同的复习顺序，而且不报错。
 */

import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { CoverageType, ReportSourceType } from '@core/enums';
import type { ReportMatchResult } from '@core/diagnosis/prompts';
import {
  BLIND_SPOT_DOMAIN_DEFAULTS,
  BLIND_SPOT_DOMAIN_NAME,
  BLIND_SPOT_POINT_DEFAULTS,
  CREDIBILITY_WEIGHT,
  boostedExamProb,
  corroborate,
  decideQuestionOutcome,
  type CorroborationSource,
} from '@core/diagnosis/reportIngest';
import { computePriority } from '@core/priority';
import { completeJson } from '../llm/json';
import { getCampaign } from './campaignLocal';
import { insertNodes, refreshAllPriorities } from './nodesLocal';
import { getDeviceIdentity } from '../sync/identity';
import { writingAs } from '../sync/triggers';

export interface DebriefIngestResult {
  reportId: string;
  questionsExtracted: number;
  nodesUpdated: number;
  blindSpotsCreated: number;
  crossCampaignUpdated: number;
  corroboratedCount: number;
  unverifiedCount: number;
}

interface NodeRow {
  id: string;
  name: string;
  exam_prob: number;
  coverage_type: string;
  mastery: number;
  est_minutes: number;
}

function listCampaignNodes(db: SQLiteDatabase, campaignId: string): NodeRow[] {
  return db.getAllSync<NodeRow>(
    `SELECT id, name, exam_prob, coverage_type, mastery, est_minutes
       FROM knowledge_node WHERE campaign_id = ?`,
    campaignId,
  );
}

function priorityOf(
  row: Pick<NodeRow, 'id' | 'coverage_type' | 'mastery' | 'est_minutes'>,
  examProb: number,
): number {
  const { score } = computePriority({
    id: row.id,
    coverageType: row.coverage_type as CoverageType,
    examProb,
    mastery: row.mastery,
    estMinutes: row.est_minutes,
  });
  return score;
}

/** 盲区域是懒建的：没有真题落到图谱之外时，不该凭空多出一个空目录 */
function ensureBlindSpotDomain(db: SQLiteDatabase, campaignId: string): string {
  const existing = db.getFirstSync<{ id: string }>(
    `SELECT id FROM knowledge_node WHERE campaign_id = ? AND name = ?`,
    campaignId,
    BLIND_SPOT_DOMAIN_NAME,
  );
  if (existing) return existing.id;

  const id = Crypto.randomUUID();
  const base = {
    id,
    campaignId,
    parentId: null,
    name: BLIND_SPOT_DOMAIN_NAME,
    ...BLIND_SPOT_DOMAIN_DEFAULTS,
    examForms: ['concept' as const],
    mastery: 0,
    masterySource: 'self' as const,
    priorityScore: 0,
    status: 'todo' as const,
    isUserAdded: true,
    createdAt: Date.now(),
  };
  insertNodes(db, [
    { ...base, priorityScore: priorityOf({ id, coverage_type: base.coverageType, mastery: 0, est_minutes: base.estMinutes }, base.examProb) },
  ]);
  return id;
}

function createBlindSpotNode(
  db: SQLiteDatabase,
  campaignId: string,
  parentId: string,
  name: string,
): NodeRow {
  const id = Crypto.randomUUID();
  const base = {
    id,
    campaignId,
    parentId,
    name: name.trim(),
    ...BLIND_SPOT_POINT_DEFAULTS,
    examForms: ['concept' as const],
    mastery: 0,
    masterySource: 'self' as const,
    priorityScore: 0,
    status: 'todo' as const,
    isUserAdded: true,
    createdAt: Date.now(),
  };
  insertNodes(db, [
    { ...base, priorityScore: priorityOf({ id, coverage_type: base.coverageType, mastery: 0, est_minutes: base.estMinutes }, base.examProb) },
  ]);
  return {
    id,
    name: base.name,
    exam_prob: base.examProb,
    coverage_type: base.coverageType,
    mastery: 0,
    est_minutes: base.estMinutes,
  };
}

/** 提到过这个考点的所有面经，喂给共享层做交叉验证 */
function corroborationFor(db: SQLiteDatabase, nodeId: string) {
  const rows = db.getAllSync<{ source_type: string; raw_text: string }>(
    `SELECT r.source_type, r.raw_text
       FROM interview_report r
       JOIN interview_question q ON q.report_id = r.id
      WHERE q.matched_node_id = ?`,
    nodeId,
  );
  const sources: CorroborationSource[] = rows.map((row) => ({
    sourceType: row.source_type as ReportSourceType,
    rawText: row.raw_text,
  }));
  return corroborate(sources);
}

function boostNode(db: SQLiteDatabase, row: NodeRow, credibilityWeight: number, factor: number): void {
  const nextProb = boostedExamProb(row.exam_prob, credibilityWeight, factor);
  db.runSync(
    `UPDATE knowledge_node SET exam_prob = ?, priority_score = ? WHERE id = ?`,
    nextProb,
    priorityOf(row, nextProb),
    row.id,
  );
}

/**
 * 按考点名跨备考回流：这家公司的真题也该抬高其它备考里同名考点的概率。
 *
 * 与桌面端 boostExamProbByNodeName 同义。按名字而不是 id 匹配，因为每场备考的考点
 * 是各自诊断出来的，同一个知识点在两场备考里是两条不同的记录。
 */
function boostOtherCampaignsByName(
  db: SQLiteDatabase,
  nodeName: string,
  campaignId: string,
  weight: number,
): number {
  const normalized = nodeName.trim().toLowerCase();
  if (!normalized) return 0;

  const rows = db.getAllSync<NodeRow & { campaign_id: string }>(
    `SELECT id, campaign_id, name, exam_prob, coverage_type, mastery, est_minutes
       FROM knowledge_node WHERE campaign_id != ?`,
    campaignId,
  );

  let updated = 0;
  for (const row of rows) {
    if (row.name.trim().toLowerCase() !== normalized) continue;
    const nextProb = boostedExamProb(row.exam_prob, weight);
    db.runSync(
      `UPDATE knowledge_node SET exam_prob = ?, priority_score = ? WHERE id = ?`,
      nextProb,
      priorityOf(row, nextProb),
      row.id,
    );
    updated++;
  }
  return updated;
}

/**
 * 复盘摄入管道：抽题 → 落库 → 匹配考点 → 修正概率 / 标记盲区。
 *
 * 两次模型调用都在写库之前完成。它们是这条链路里唯一可能失败的部分（离线、超时、
 * 返回的 JSON 坏掉），放在事务之外意味着失败时用户的那段口述还在输入框里，重试一次
 * 就好；反过来先落库再调模型，失败就会留下一条没有任何题目的空复盘。
 */
export async function ingestSelfDebrief(
  db: SQLiteDatabase,
  campaignId: string,
  rawText: string,
): Promise<DebriefIngestResult> {
  const text = rawText.trim();
  if (!text) throw new Error('复盘内容为空');

  const campaign = getCampaign(db, campaignId);
  const extracted = await completeJson<{ questions: string[] }>(
    'outline',
    'diagnosis.extractQuestions',
    text,
  );
  const questions = (extracted.questions ?? []).map((q) => q.trim()).filter(Boolean);

  const nodes = listCampaignNodes(db, campaignId);
  const matches =
    questions.length === 0
      ? []
      : (
          await completeJson<ReportMatchResult>(
            'outline',
            'diagnosis.matchQuestions',
            JSON.stringify({ questions, nodes: nodes.map((n) => n.name) }),
          )
        ).matches ?? [];

  const sourceType: ReportSourceType = 'selfDebrief';
  const credibilityWeight = CREDIBILITY_WEIGHT[sourceType];
  const reportId = Crypto.randomUUID();
  const now = Date.now();
  const identity = await getDeviceIdentity(db);
  const nodeByName = new Map(nodes.map((n) => [n.name, n]));

  let nodesUpdated = 0;
  let blindSpotsCreated = 0;
  let crossCampaignUpdated = 0;
  let corroboratedCount = 0;
  let unverifiedCount = 0;

  writingAs(db, identity.deviceId, () => {
    db.runSync(
      `INSERT INTO interview_report
         (id, campaign_id, company, role_title, source_type, source_id, raw_text, reported_at, credibility_weight, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      reportId,
      campaignId,
      campaign.company,
      campaign.roleTitle,
      sourceType,
      text,
      now,
      credibilityWeight,
      now,
    );

    for (let i = 0; i < questions.length; i++) {
      const outcome = decideQuestionOutcome(
        matches.find((m) => m.questionIndex === i),
        nodeByName,
      );

      let matched = outcome.kind === 'matched' ? nodeByName.get(outcome.nodeName) ?? null : null;
      if (outcome.kind === 'newBlindSpot') {
        const parentId = ensureBlindSpotDomain(db, campaignId);
        matched = createBlindSpotNode(db, campaignId, parentId, outcome.suggestedName);
        nodeByName.set(matched.name, matched);
        blindSpotsCreated++;
      }

      db.runSync(
        `INSERT INTO interview_question
           (id, report_id, question_text, round_no, matched_node_id, match_confidence, is_blind_spot, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
        Crypto.randomUUID(),
        reportId,
        questions[i]!,
        matched?.id ?? null,
        outcome.confidence,
        matched ? 0 : 1,
        now,
      );

      if (!matched) continue;

      // 先落库本题再算交叉验证，这样当前这一篇也计入来源计数
      const { factor, verified } = corroborationFor(db, matched.id);
      if (verified) corroboratedCount++;
      else unverifiedCount++;

      boostNode(db, matched, credibilityWeight, factor);
      nodesUpdated++;
      crossCampaignUpdated += boostOtherCampaignsByName(
        db,
        matched.name,
        campaignId,
        credibilityWeight * factor,
      );
    }

    // 复盘意味着这场面试已经面完了
    db.runSync(`UPDATE campaign SET status = 'done', updated_at = ? WHERE id = ?`, now, campaignId);

    // 放在 writingAs 里面：priority_score 也是同步列，写在外面就要靠「上一次
    // writingAs 恰好没把 writeAs 还原回去」才能被记进 oplog
    refreshAllPriorities(db, campaignId);
  });

  return {
    reportId,
    questionsExtracted: questions.length,
    nodesUpdated,
    blindSpotsCreated,
    crossCampaignUpdated,
    corroboratedCount,
    unverifiedCount,
  };
}

/** 摄入结果的一句话汇报。盲区单独点出来——那是图谱没预测到的题，信息价值最高 */
export function describeDebriefResult(result: DebriefIngestResult): string {
  if (result.questionsExtracted === 0) return '没能从这段复盘里抽出题目，可以再补充些细节';

  const parts = [`抽出 ${result.questionsExtracted} 道题`];
  if (result.nodesUpdated > 0) parts.push(`修正 ${result.nodesUpdated} 个考点`);
  if (result.blindSpotsCreated > 0) parts.push(`新增 ${result.blindSpotsCreated} 个盲区考点`);
  if (result.crossCampaignUpdated > 0) parts.push(`回流到 ${result.crossCampaignUpdated} 个其它备考考点`);
  return parts.join('，');
}
