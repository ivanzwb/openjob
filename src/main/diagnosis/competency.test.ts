/**
 * Campaign 能力诊断的端到端用例：真迁移建库、真 runtime descriptor、真取数。
 *
 * 纯函数层已经验过算法，这里只验接线：岗位包必须从 Campaign 绑定里取（而不是
 * import 一个内置包），证据必须走 listConfirmedEvidence（而不是把整张表读出来），
 * JD 缺席时不能整条链路报错。
 */
import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { softwareEngineeringRolePack } from '@shared/plugins/rolePacks/softwareEngineering';
import { newLegacyDb } from '../db/__fixtures__/legacyDb';
import { installRolePacks } from '../plugins/__fixtures__/installedPlugins';
import { setCampaignRoleProfile } from '../plugins/runtime';
import { diagnoseCampaignCompetencies } from './competency';

const CAMPAIGN_ID = 'c-acme';

const JD_PARSED = {
  roleTitle: '后端工程师',
  seniority: 'senior',
  requirements: [
    { skill: '熟悉分布式系统设计与高并发架构', weight: 0.6 },
    { skill: '扎实的数据结构与算法基础', weight: 0.4 },
  ],
};

function newDb(options: { jdParsed?: unknown } = {}): Database {
  // 岗位包由用户安装，绑定之前先装上
  installRolePacks();
  const raw = newLegacyDb();
  raw
    .prepare(
      `INSERT INTO campaign (id, company, role_title, jd_raw, jd_parsed, status, created_at, updated_at)
       VALUES (?, 'ACME', '后端工程师', 'JD 原文', ?, 'planning', 1, 1)`,
    )
    .run(
      CAMPAIGN_ID,
      options.jdParsed === undefined ? JSON.stringify(JD_PARSED) : options.jdParsed,
    );
  setCampaignRoleProfile(
    raw,
    {
      campaignId: CAMPAIGN_ID,
      roleFamily: 'software',
      rolePackId: softwareEngineeringRolePack.manifest.id,
    },
    { now: () => 1000 },
  );
  return raw;
}

function insertEvidence(
  raw: Database,
  id: string,
  kind: string,
  statement: string,
  status: string,
): void {
  raw
    .prepare(
      `INSERT INTO candidate_evidence (
         id, campaign_id, kind, title, statement, source_kind, source_document_id,
         source_start, source_end, source_text, occurred_at, confidence, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'resume', 'r-1', 0, 10, ?, NULL, 0.9, ?, 1, 1)`,
    )
    .run(id, CAMPAIGN_ID, kind, statement.slice(0, 8), statement, statement, status);
}

describe('diagnoseCampaignCompetencies', () => {
  it('能力清单来自 Campaign 绑定的岗位包版本', async () => {
    const raw = newDb();
    const diagnosis = await diagnoseCampaignCompetencies(
      { raw },
      { campaignId: CAMPAIGN_ID, upcomingStageId: 'se.coding-interview' },
    );

    expect(diagnosis.rolePackId).toBe(softwareEngineeringRolePack.manifest.id);
    expect(diagnosis.rolePackVersion).toBe(softwareEngineeringRolePack.manifest.version);
    expect(diagnosis.competencies.map((item) => item.templateId).sort()).toEqual(
      softwareEngineeringRolePack.competencyTemplates.map((item) => item.id).sort(),
    );
    expect(diagnosis.upcomingStageId).toBe('se.coding-interview');
  });

  it('只有已确认的证据能改变覆盖类型', async () => {
    const raw = newDb();
    insertEvidence(
      raw,
      'e-proposed',
      'experience',
      '主导订单系统设计重构，把 P99 延迟从 800ms 降到 120ms',
      'proposed',
    );

    const before = await diagnoseCampaignCompetencies({ raw }, { campaignId: CAMPAIGN_ID });
    expect(
      before.competencies.find((item) => item.templateId === 'se.system-design')?.coverageType,
    ).toBe('gap');

    raw.prepare(`UPDATE candidate_evidence SET status = 'confirmed' WHERE id = 'e-proposed'`).run();
    const after = await diagnoseCampaignCompetencies({ raw }, { campaignId: CAMPAIGN_ID });
    const design = after.competencies.find((item) => item.templateId === 'se.system-design');
    expect(design?.coverageType).toBe('deepDive');
    expect(design?.evidence.map((link) => link.evidenceId)).toEqual(['e-proposed']);
  });

  it('JD 还没解析时给出岗位包基线，而不是报错', async () => {
    const raw = newDb({ jdParsed: null });
    const diagnosis = await diagnoseCampaignCompetencies({ raw }, { campaignId: CAMPAIGN_ID });
    expect(diagnosis.roleTitle).toBe('后端工程师');
    expect(diagnosis.competencies).toHaveLength(
      softwareEngineeringRolePack.competencyTemplates.length,
    );
    expect(diagnosis.uncoveredRequirements).toEqual([]);
  });

  it('没有绑定岗位包的 Campaign 停下来报错，不退化到某个默认包', async () => {
    const raw = newLegacyDb();
    raw
      .prepare(
        `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
         VALUES ('c-bare', 'ACME', '后端工程师', 'JD', 'planning', 1, 1)`,
      )
      .run();
    await expect(
      diagnoseCampaignCompetencies({ raw }, { campaignId: 'c-bare' }),
    ).rejects.toThrow();
  });
});
