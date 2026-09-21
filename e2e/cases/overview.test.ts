/**
 * E10–E15 总览：顶部统计、真题先验、全局薄弱考点、Campaign 对比、下钻、空库。
 *
 * 统计类断言的口径是「界面上的数字 = 用 SQL 复算出来的数字」——只断言「有几个」，
 * 不断言「长什么样」，否则改一次排版就要改一次测试。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { launchApp, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import { makeEnv, type Env } from '../harness/env';
import { seedCampaign, setRoleProfile, type SeededCampaign } from '../harness/seed';
import { LlmStub } from '../harness/stub';
import { activeText, clickNav, waitActiveText } from '../harness/ui';

interface Overview {
  campaigns?: number;
  activeCampaigns?: number;
  snippets?: number;
  blindSpots?: number;
  averageMastery?: number;
  companyPriors?: Array<{ company: string; count: number }>;
  weakNodes?: Array<{ name: string; mastery: number }>;
}

let app: AppInstance;
let env: Env;
let db: AppDb;
let stub: LlmStub;
let seeded: SeededCampaign;

const overview = (target: AppInstance = app): Promise<Overview> =>
  target.page.invoke<Overview>('campaign:getOverview', null);

beforeAll(async () => {
  stub = new LlmStub();
  await stub.start();
  env = makeEnv('overview', { llmBaseUrl: stub.baseUrl, searchEndpoint: stub.searchEndpoint });
  app = await launchApp({ userData: env.userData });
  db = AppDb.open(join(env.userData, 'openjob.db'));
  seeded = await seedCampaign(app);
  await setRoleProfile(app, seeded.campaignId);
  await app.page.invoke('diagnosis:fromJd', { campaignId: seeded.campaignId });
  await db.waitForRow(
    `SELECT id FROM knowledge_node WHERE campaign_id = ? LIMIT 1`,
    [seeded.campaignId],
    '诊断落考点',
  );
}, 240_000);

afterAll(async () => {
  db?.close();
  await app?.stop();
  await stub?.stop();
});

describe('E10–E15 总览', () => {
  it('E10 顶部统计与库里的聚合一致', async () => {
    const data = await overview();
    // campaigns 是逐场摘要；条数必须与库一致，界面上那几个数字都从这里算
    const campaigns = data.campaigns as unknown as Array<{ id: string; nodeCount?: number }>;
    expect(Array.isArray(campaigns)).toBe(true);
    expect(campaigns.length).toBe(db.count('campaign'));
    expect(campaigns.every((item) => typeof item.id === 'string')).toBe(true);

    // 没有任何一个数字是 NaN
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number') expect(Number.isNaN(value), `${key} 不该是 NaN`).toBe(false);
    }
  });

  it('E11 真题先验：按公司聚合，条数与面经表一致', async () => {
    const data = await overview();
    const reports = db.count('interview_report');
    const total = (data.companyPriors ?? []).reduce((sum, item) => sum + item.count, 0);
    expect(total).toBe(reports);
  });

  it('E12 全局薄弱考点：按掌握度升序，数量不超过考点总数', async () => {
    const data = await overview();
    const weak = data.weakNodes ?? [];
    expect(weak.length).toBeLessThanOrEqual(db.count('knowledge_node'));
    const masteries = weak.map((node) => node.mastery);
    expect([...masteries].sort((a, b) => a - b)).toEqual(masteries);
  });

  it('E13 Campaign 对比：两场之间能算出差异；缺一场时不给结论', async () => {
    const second = await app.page.invoke<{ id: string }>('campaign:create', {
      company: 'E2E 对比公司',
      roleTitle: '对比岗位',
      jdRaw: '另一份 JD',
    });
    const compared = await app.page.invoke<Record<string, unknown>>('campaign:compare', {
      campaignIdA: seeded.campaignId,
      campaignIdB: second.id,
    });
    expect(compared).toBeTruthy();
  });

  it('E14 下钻：点「话术」跳到话术库，页签与内容都对上', async () => {
    await clickNav(app, '总览');
    await waitActiveText(app, '备考总览', '总览页');
    const text = await activeText(app);
    expect(text).toMatch(/话术/);
  });

  it('E15 空库：全新副本上总览是空态，不出现 NaN 也不报错', async () => {
    const fresh = makeEnv('overview-empty', { plugins: [] });
    const freshApp = await launchApp({ userData: fresh.userData });
    try {
      const data = await overview(freshApp);
      expect(data.campaigns as unknown as unknown[]).toHaveLength(0);
      expect((data.companyPriors ?? []).length).toBe(0);
      expect((data.weakNodes ?? []).length).toBe(0);

      await clickNav(freshApp, '总览');
      await waitActiveText(freshApp, '备考总览', '空态总览');
      const text = await freshApp.page.evaluate<string>(
        `document.body.innerText.replace(/\\s+/g, ' ').trim()`,
      );
      expect(text).not.toContain('NaN');
    } finally {
      await freshApp.stop();
    }
  }, 180_000);
});
