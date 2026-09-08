/**
 * Story 用例的建库脚手架：真迁移、真运行时描述符、真证据行。
 *
 * 证据直接按 confirmed 落库而不走抽取器：这些用例要验的是 Story 侧的 fail-closed，
 * 而不是抽取与定位。运行时描述符仍走 setCampaignRoleProfile，因为口述要求
 * composePrompt 里的岗位包版本与 descriptor 逐字一致，手写的假绑定过不了那一关。
 */

import type { Database } from 'better-sqlite3';
import { softwareEngineeringRolePack } from '@shared/plugins/builtin/softwareEngineering';
import { newLegacyDb } from '../../db/__fixtures__/legacyDb';
import { setCampaignRoleProfile } from '../../plugins/runtime';

export const CAMPAIGN_ID = 'c-acme';
/** 另一场备考，用来验「跨备考的证据不能接到这个 Story 上」 */
export const OTHER_CAMPAIGN_ID = 'c-globex';

export const THROUGHPUT_EVIDENCE_ID = 'ev-throughput';
export const TEAM_EVIDENCE_ID = 'ev-team';
export const PROPOSED_EVIDENCE_ID = 'ev-proposed';
export const OTHER_CAMPAIGN_EVIDENCE_ID = 'ev-globex';

export const RESUME_ID = 'r-zhang';

const RESUME_MD = `## 工作经历

### ACME | 后端工程师 | 2022-03 ~ 2024-06

- 主导订单履约链路重构，高峰期 QPS 从 3000 提到 12000
- 带 4 人小组完成消息中间件迁移，全程零故障
`;

interface EvidenceSeed {
  id: string;
  campaignId: string;
  title: string;
  statement: string;
  quote: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  occurredAt?: string | null;
}

const EVIDENCE_SEEDS: EvidenceSeed[] = [
  {
    id: THROUGHPUT_EVIDENCE_ID,
    campaignId: CAMPAIGN_ID,
    title: '订单履约链路重构',
    statement: '主导订单履约链路重构，高峰期 QPS 从 3000 提到 12000',
    quote: '主导订单履约链路重构，高峰期 QPS 从 3000 提到 12000',
    status: 'confirmed',
  },
  {
    id: TEAM_EVIDENCE_ID,
    campaignId: CAMPAIGN_ID,
    title: '消息中间件迁移',
    statement: '带 4 人小组完成消息中间件迁移，全程零故障',
    quote: '带 4 人小组完成消息中间件迁移，全程零故障',
    status: 'confirmed',
    occurredAt: '2023-05',
  },
  {
    id: PROPOSED_EVIDENCE_ID,
    campaignId: CAMPAIGN_ID,
    title: '待确认的技能',
    statement: '熟悉 Kubernetes 集群治理',
    quote: '熟悉 Kubernetes 集群治理',
    status: 'proposed',
  },
  {
    id: OTHER_CAMPAIGN_EVIDENCE_ID,
    campaignId: OTHER_CAMPAIGN_ID,
    title: '另一场备考的经历',
    statement: '在 Globex 负责计费系统',
    quote: '在 Globex 负责计费系统',
    status: 'confirmed',
  },
];

function insertCampaign(raw: Database, id: string, company: string): void {
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
       VALUES (?, ?, '后端工程师', 'JD', 'planning', 1, 1)`,
    )
    .run(id, company);
}

export function newStoryDb(): Database {
  const raw = newLegacyDb();

  raw
    .prepare(
      `INSERT INTO resume (id, label, raw_text, created_at, updated_at)
       VALUES (?, '母版', ?, 1, 1)`,
    )
    .run(RESUME_ID, RESUME_MD);
  insertCampaign(raw, CAMPAIGN_ID, 'ACME');
  insertCampaign(raw, OTHER_CAMPAIGN_ID, 'Globex');

  for (const seed of EVIDENCE_SEEDS) {
    const start = Math.max(RESUME_MD.indexOf(seed.quote), 0);
    raw
      .prepare(
        `INSERT INTO candidate_evidence (
           id, campaign_id, kind, title, statement, source_kind, source_document_id,
           source_start, source_end, source_text, occurred_at, confidence, status,
           created_at, updated_at
         ) VALUES (?, ?, 'achievement', ?, ?, 'resume', ?, ?, ?, ?, ?, 1, ?, 1, 1)`,
      )
      .run(
        seed.id,
        seed.campaignId,
        seed.title,
        seed.statement,
        RESUME_ID,
        start,
        start + seed.quote.length,
        seed.quote,
        seed.occurredAt ?? null,
        seed.status,
      );
  }

  for (const campaignId of [CAMPAIGN_ID, OTHER_CAMPAIGN_ID]) {
    setCampaignRoleProfile(
      raw,
      {
        campaignId,
        roleFamily: 'software',
        rolePackId: softwareEngineeringRolePack.manifest.id,
      },
      { now: () => 1000 },
    );
  }

  return raw;
}

/** 一个合法的 STAR 输入：标题、四段叙事、两条已确认证据 */
export const STORY_INPUT = {
  campaignId: CAMPAIGN_ID,
  title: '订单履约链路重构',
  situationMd: '大促前订单履约链路频繁超时，运营每天都在催。',
  taskMd: '我负责把高峰期的吞吐提上来，并且不能影响对账。',
  actionMd: '拆出异步补偿队列，重写幂等键，把重试从同步链路上摘下来。',
  resultMd: '大促当天没有再出现超时，对账差异归零。',
  evidenceIds: [THROUGHPUT_EVIDENCE_ID, TEAM_EVIDENCE_ID],
};

export function evidenceRows(raw: Database): Array<Record<string, unknown>> {
  return raw
    .prepare(`SELECT * FROM candidate_evidence ORDER BY id`)
    .all() as Array<Record<string, unknown>>;
}

export function countRows(raw: Database, table: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
