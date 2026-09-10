/**
 * 练习用例的建库脚手架：真迁移、真运行时描述符。
 *
 * 描述符走 setCampaignRoleProfile 而不是手写一行 binding：出题与评分都要求
 * composePrompt 里的岗位包版本与 descriptor 逐字一致，手写的假绑定过不了那一关，
 * 也就测不到真实调用路径。
 */

import type { Database } from 'better-sqlite3';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '@shared/plugins/legacyRoleData';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { newLegacyDb } from '../../db/__fixtures__/legacyDb';
import { installRolePacks } from '../../plugins/__fixtures__/installedPlugins';
import { setCampaignRoleProfile } from '../../plugins/runtime';

export const CAMPAIGN_ID = 'c-acme';
export const NODE_ID = 'n-mq-idempotent';
export const ROLE_PACK_ID = softwareEngineeringRolePack.manifest.id;
/** 技术知识问答：追问上限 3 轮，量规 se.technical-knowledge-rubric */
export const KNOWLEDGE_FORMAT_ID = SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge;

export interface PracticeFixtureOptions {
  /** 考点初始掌握度与来源，用来验混合权重 */
  mastery?: number;
  masterySource?: 'self' | 'quiz' | 'mixed';
}

export function newPracticeDb(options: PracticeFixtureOptions = {}): Database {
  // 岗位包不再随应用发布，绑定岗位之前必须先「装上」，否则解析直接 plugin-not-found
  installRolePacks();
  const raw = newLegacyDb();

  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, 'ACME', '后端工程师', 'JD', 'planning', 1, 1)`,
    )
    .run(CAMPAIGN_ID);

  raw
    .prepare(
      `INSERT INTO knowledge_node (
         id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
         est_minutes, exam_forms, mastery, mastery_source, priority_score, status, created_at
       ) VALUES (?, ?, NULL, '消息队列幂等消费', 'topic', 'deepDive', 0.8, 4,
                 30, '["concept"]', ?, ?, 0, 'learning', 1)`,
    )
    .run(NODE_ID, CAMPAIGN_ID, options.mastery ?? 2, options.masterySource ?? 'self');

  setCampaignRoleProfile(
    raw,
    { campaignId: CAMPAIGN_ID, roleFamily: 'software', rolePackId: ROLE_PACK_ID },
    { now: () => 1000 },
  );

  return raw;
}

export function nodeRow(
  raw: Database,
  nodeId = NODE_ID,
): { mastery: number; mastery_source: string; status: string; priority_score: number } {
  return raw
    .prepare(
      `SELECT mastery, mastery_source, status, priority_score FROM knowledge_node WHERE id = ?`,
    )
    .get(nodeId) as never;
}

/** 候选人作答的原文。评分引文必须能逐字定位到这段里，否则不许落库。 */
export const ANSWER_MD = `我们用 Kafka 的消费位点配合业务侧的去重表来做幂等。

消费端先按消息 ID 查去重表，命中就直接 ack 不再执行业务逻辑。写入去重表和业务
落库放在同一个本地事务里，避免出现「业务成功但去重记录丢了」的窗口。

位点提交改成手动，业务事务提交成功之后才提交位点。`;
