/**
 * EvidenceService 的端到端用例：真实迁移建库，真实取数，真实落库。
 *
 * 四条验收边界都在这里过一遍数据库，而不只是在纯函数层验：
 * 来源分组、JD 不能成为证据、未确认项不外流、每条证据可回指原文。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { newLegacyDb } from '../db/__fixtures__/legacyDb';
import { EvidenceRejectedError, locateInDocument } from '@core/evidence';
import type { EvidenceProposal } from '@core/evidence';
import {
  COMPANY_INTEL_MD,
  JD_ONLY_PHRASES,
  JD_RAW,
  RESUME_MD,
  SELF_REPORT_MD,
} from '@core/evidence/__fixtures__/candidateDocuments';
import { loadCandidateDocuments, loadJobContextDocuments } from './documents';
import { listProposedEvidence } from './repository';
import { createEvidenceService, extractCampaignEvidence } from './service';

const CAMPAIGN_ID = 'c-acme';
const RESUME_ID = 'r-zhang';
const VARIANT_ID = 'rv-zhang-acme';
const REPORT_ID = 'rep-acme-1';

function seed(raw: Database): void {
  raw
    .prepare(
      `INSERT INTO resume (id, label, raw_text, created_at, updated_at)
       VALUES (?, '母版', ?, 1, 1)`,
    )
    .run(RESUME_ID, RESUME_MD);
  raw
    .prepare(
      `INSERT INTO job_target (id, company, role_title, jd_raw, created_at, updated_at)
       VALUES ('jt-acme', 'ACME', '后端工程师', ?, 1, 1)`,
    )
    .run(JD_RAW);
  raw
    .prepare(
      `INSERT INTO resume_variant (
         id, source_resume_id, job_target_id, label, content_md, created_at, updated_at
       ) VALUES (?, ?, 'jt-acme', 'ACME 版', ?, 2, 2)`,
    )
    .run(VARIANT_ID, RESUME_ID, RESUME_MD);
  raw
    .prepare(
      `INSERT INTO campaign (
         id, company, role_title, jd_raw, job_target_id, resume_id,
         status, created_at, updated_at
       ) VALUES (?, 'ACME', '后端工程师', ?, 'jt-acme', ?, 'planning', 1, 1)`,
    )
    .run(CAMPAIGN_ID, JD_RAW, RESUME_ID);
  raw
    .prepare(
      `INSERT INTO company_intel (id, campaign_id, tech_stack_md, hot_topics_md, updated_at)
       VALUES ('ci-acme', ?, ?, '', 1)`,
    )
    .run(CAMPAIGN_ID, COMPANY_INTEL_MD);
  raw
    .prepare(
      `INSERT INTO interview_report (
         id, campaign_id, company, role_title, source_type, raw_text, created_at
       ) VALUES (?, ?, 'ACME', '后端工程师', 'selfDebrief', ?, 3)`,
    )
    .run(REPORT_ID, CAMPAIGN_ID, SELF_REPORT_MD);
  // 抓来的面经是别人的经历，读起来同样像第一人称，但不是这位候选人做过的事
  raw
    .prepare(
      `INSERT INTO interview_report (
         id, campaign_id, company, role_title, source_type, raw_text, created_at
       ) VALUES ('rep-web-1', ?, 'ACME', '后端工程师', 'web', '- 网上抄来的面经', 4)`,
    )
    .run(CAMPAIGN_ID);
}

let raw: Database;
let clock = 100;

function service(): ReturnType<typeof createEvidenceService> {
  let counter = 0;
  return createEvidenceService(raw, {
    now: () => (clock += 1),
    newId: () => `ev-${(counter += 1)}`,
  });
}

beforeEach(() => {
  raw = newLegacyDb();
  seed(raw);
  clock = 100;
});

describe('来源分组', () => {
  it('候选人文档与岗位文档从不同的入口取，返回类型互不通用', () => {
    const candidates = loadCandidateDocuments(raw, CAMPAIGN_ID);
    const jobContext = loadJobContextDocuments(raw, CAMPAIGN_ID);

    expect(candidates.map((doc) => doc.kind)).toEqual(['resume', 'resumeVariant', 'selfReport']);
    expect(jobContext.map((doc) => doc.kind)).toEqual(['jd', 'company']);

    const candidateKinds = new Set(candidates.map((doc) => doc.kind));
    for (const doc of jobContext) {
      expect(candidateKinds.has(doc.kind as never)).toBe(false);
    }
  });

  it('只有自己面完的复盘算候选人自述，抓来的面经不算', () => {
    const selfReports = loadCandidateDocuments(raw, CAMPAIGN_ID).filter(
      (doc) => doc.kind === 'selfReport',
    );

    expect(selfReports.map((doc) => doc.id)).toEqual([REPORT_ID]);
  });
});

describe('JD 内容不能成为 CandidateEvidence', () => {
  it('抽取结果里没有一条来自 JD 或公司情报', () => {
    const proposals = extractCampaignEvidence(raw, CAMPAIGN_ID);

    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(['resume', 'resumeVariant', 'selfReport']).toContain(proposal.source.kind);
      for (const phrase of JD_ONLY_PHRASES) {
        expect(proposal.statement).not.toContain(phrase);
        expect(proposal.source.quote).not.toContain(phrase);
      }
    }
  });

  it('直接把 source.kind = jd 的 proposal 递给 propose 会被拒，库里也不留痕', async () => {
    const jdProposal: EvidenceProposal = {
      campaignId: CAMPAIGN_ID,
      kind: 'experience',
      title: '跨机房容灾演练',
      statement: '主导过 跨机房容灾演练',
      source: {
        kind: 'jd' as never,
        documentId: CAMPAIGN_ID,
        start: JD_RAW.indexOf('主导过'),
        end: JD_RAW.indexOf('主导过') + '主导过 跨机房容灾演练'.length,
        quote: '主导过 跨机房容灾演练',
      },
      occurredAt: null,
      confidence: 0.9,
    };

    await expect(service().propose(jdProposal)).rejects.toBeInstanceOf(EvidenceRejectedError);
    await expect(service().propose(jdProposal)).rejects.toMatchObject({
      code: 'job-context-source',
    });
    expect(listProposedEvidence(raw, { campaignId: CAMPAIGN_ID })).toHaveLength(0);
  });

  it('把来源伪装成简历、正文照抄 JD，同样进不来——引文在简历里定位不到', async () => {
    const disguised: EvidenceProposal = {
      campaignId: CAMPAIGN_ID,
      kind: 'experience',
      title: 'Kubernetes 集群治理',
      statement: '有 Kubernetes 集群治理经验',
      source: {
        kind: 'resume',
        documentId: RESUME_ID,
        start: 0,
        end: '有 Kubernetes 集群治理经验'.length,
        quote: '有 Kubernetes 集群治理经验',
      },
      occurredAt: null,
      confidence: 0.9,
    };

    await expect(service().propose(disguised)).rejects.toMatchObject({
      code: 'quote-not-anchored',
    });
    expect(listProposedEvidence(raw, { campaignId: CAMPAIGN_ID })).toHaveLength(0);
  });
});

describe('未确认 proposal 不进入个人化回答', () => {
  it('落库后默认是 proposed，listConfirmed 一条也不返回', async () => {
    const api = service();
    const [first] = extractCampaignEvidence(raw, CAMPAIGN_ID);
    const stored = await api.propose(first);

    expect(stored.status).toBe('proposed');
    expect(await api.listConfirmed({ campaignId: CAMPAIGN_ID })).toEqual([]);
    expect(listProposedEvidence(raw, { campaignId: CAMPAIGN_ID })).toHaveLength(1);
  });

  it('确认之后才出现在 listConfirmed 里', async () => {
    const api = service();
    const stored = await api.propose(extractCampaignEvidence(raw, CAMPAIGN_ID)[0]);
    const confirmed = await api.confirm(stored.id);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.updatedAt).toBeGreaterThan(stored.updatedAt);
    expect((await api.listConfirmed({ campaignId: CAMPAIGN_ID })).map((item) => item.id)).toEqual([
      stored.id,
    ]);
  });

  it('拒绝掉的条目从 confirmed 与 proposed 两个列表里同时消失', async () => {
    const api = service();
    const stored = await api.propose(extractCampaignEvidence(raw, CAMPAIGN_ID)[0]);
    await api.confirm(stored.id);
    await api.reject(stored.id);

    expect(await api.listConfirmed({ campaignId: CAMPAIGN_ID })).toEqual([]);
    expect(listProposedEvidence(raw, { campaignId: CAMPAIGN_ID })).toEqual([]);
  });

  it('重复抽取不会把已确认项打回待确认，也不会让被拒项复活', async () => {
    const api = service();
    const proposals = extractCampaignEvidence(raw, CAMPAIGN_ID);
    const kept = await api.propose(proposals[0]);
    const dropped = await api.propose(proposals[1]);
    await api.confirm(kept.id);
    await api.reject(dropped.id);

    for (const proposal of extractCampaignEvidence(raw, CAMPAIGN_ID)) {
      await api.propose(proposal);
    }

    expect((await api.listConfirmed({ campaignId: CAMPAIGN_ID })).map((item) => item.id)).toEqual([
      kept.id,
    ]);
    expect(listProposedEvidence(raw, { campaignId: CAMPAIGN_ID }).map((item) => item.id)).not.toContain(
      dropped.id,
    );
  });

  it('scope 能按来源和事实类型收窄，但收不出未确认项', async () => {
    const api = service();
    for (const proposal of extractCampaignEvidence(raw, CAMPAIGN_ID)) {
      const stored = await api.propose(proposal);
      await api.confirm(stored.id);
    }

    const skills = await api.listConfirmed({ campaignId: CAMPAIGN_ID, kinds: ['skill'] });
    const fromSelfReport = await api.listConfirmed({
      campaignId: CAMPAIGN_ID,
      sourceKinds: ['selfReport'],
    });

    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((item) => item.kind === 'skill')).toBe(true);
    expect(fromSelfReport.length).toBeGreaterThan(0);
    expect(fromSelfReport.every((item) => item.source.kind === 'selfReport')).toBe(true);
  });
});

describe('每条 Evidence 可定位原文', () => {
  it('落库往返之后仍能用存下来的区间从原文切回同一段字', async () => {
    const api = service();
    const documents = loadCandidateDocuments(raw, CAMPAIGN_ID);
    const stored = await Promise.all(
      extractCampaignEvidence(raw, CAMPAIGN_ID).map((proposal) => api.propose(proposal)),
    );

    expect(stored.length).toBeGreaterThan(5);
    for (const item of stored) {
      const document = documents.find(
        (doc) => doc.id === item.source.documentId && doc.kind === item.source.kind,
      );
      expect(document).toBeDefined();
      const located = locateInDocument(item.source, document!);
      expect(located).not.toBeNull();
      expect(located!.line).toBeGreaterThan(0);
      expect(document!.text.slice(item.source.start, item.source.end)).toBe(item.source.quote);
    }
  });

  it('简历被改过之后，原来那条证据不允许再确认', async () => {
    const api = service();
    const stored = await api.propose(extractCampaignEvidence(raw, CAMPAIGN_ID)[0]);

    // 用户在抽取和确认之间重写了简历：老区间现在指向另一段文字
    raw
      .prepare(`UPDATE resume SET raw_text = ? WHERE id = ?`)
      .run(`## 工作经历\n\n### 另一家公司 | 前端工程师 | 2019-01 ~ 2020-12\n`, RESUME_ID);

    await expect(api.confirm(stored.id)).rejects.toMatchObject({ code: 'quote-not-anchored' });
    expect(await api.listConfirmed({ campaignId: CAMPAIGN_ID })).toEqual([]);
  });
});
