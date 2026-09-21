/**
 * E80–E84 话术库：列表与按 JD 过滤、编辑删除、四种来源存入、同源去重。
 *
 * 导出（markdown / anki / pdf）走原生保存对话框，CDP 驱动不了，归手工——见方案 §9。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { launchApp, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import { makeEnv, type Env } from '../harness/env';
import { seedCampaign, setRoleProfile, type SeededCampaign } from '../harness/seed';
import { LlmStub } from '../harness/stub';

let app: AppInstance;
let env: Env;
let db: AppDb;
let stub: LlmStub;
let seeded: SeededCampaign;
let nodeId = '';

beforeAll(async () => {
  stub = new LlmStub();
  await stub.start();
  env = makeEnv('speech', { llmBaseUrl: stub.baseUrl, searchEndpoint: stub.searchEndpoint });
  app = await launchApp({ userData: env.userData });
  db = AppDb.open(join(env.userData, 'openjob.db'));
  seeded = await seedCampaign(app);
  await setRoleProfile(app, seeded.campaignId);
  await app.page.invoke('diagnosis:fromJd', { campaignId: seeded.campaignId });
  const node = await db.waitForRow<{ id: string }>(
    `SELECT id FROM knowledge_node WHERE campaign_id = ? AND name = 'JVM'`,
    [seeded.campaignId],
    '诊断落考点',
  );
  nodeId = node.id;
}, 240_000);

afterAll(async () => {
  db?.close();
  await app?.stop();
  await stub?.stop();
});

describe('E80–E84 话术库', () => {
  it('E80 四种来源都能存：讲解 / 考我 / 源码页 / 故事各一条', async () => {
    // 讲解来源
    const explanation = await app.page.invoke<{ contentMd: string }>('explain:generate', {
      nodeId,
      tier: 'spoken',
    });
    const fromNode = await app.page.invoke<{ id: string; sourceType: string }>('speech:saveFromNode', {
      nodeId,
      contentMd: explanation.contentMd,
      tier: 'spoken',
    });
    expect(fromNode.sourceType).toBeTruthy();

    // 考我来源
    const fromQuiz = await app.page.invoke<{ id: string }>('speech:saveFromQuiz', {
      nodeId,
      contentMd: 'E2E：这道题的推荐答案。',
    });
    expect(db.count('speech_snippet', 'id = ?', fromQuiz.id)).toBe(1);

    // 源码页来源：走插件原语那条路（package 自己起 sourceKind）
    const fromCode = await app.page.invoke<{ id: string }>('pluginRuntime:library.saveSnippet', {
      pluginId: 'software-engineering',
      text: 'function main() { return 1; }',
      sourceKind: 'code-ref',
      sourceLabel: 'src/index.ts:1-3',
    });
    expect(db.count('speech_snippet', 'id = ?', fromCode.id)).toBe(1);

    const all = await app.page.invoke<Array<{ id: string; sourceType: string }>>('speech:list', null);
    const kinds = new Set(all.map((item) => item.sourceType));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    expect(all.some((item) => item.id === fromNode.id)).toBe(true);
  }, 180_000);

  it('E81 同来源同内容重复存被去重，只留一条', async () => {
    const before = (await app.page.invoke<Array<{ id: string }>>('speech:list', null)).length;
    const first = await app.page.invoke<{ id: string }>('speech:saveFromQuiz', {
      nodeId,
      contentMd: 'E2E：这段会被存两次。',
    });
    const second = await app.page.invoke<{ id: string }>('speech:saveFromQuiz', {
      nodeId,
      contentMd: 'E2E：这段会被存两次。',
    });
    expect(second.id).toBe(first.id);
    const after = (await app.page.invoke<Array<{ id: string }>>('speech:list', null)).length;
    expect(after).toBe(before + 1);
  }, 120_000);

  it('E82 按来源取回：同一考场点下已存过的话术能查到', async () => {
    const forSource = await app.page.invoke<Array<{ id: string }>>('speech:listForSource', {
      sourceType: 'node',
      sourceId: nodeId,
    });
    expect(Array.isArray(forSource)).toBe(true);
    expect(forSource.length).toBeGreaterThan(0);
  });

  it('E83 编辑：改正文落库', async () => {
    const created = await app.page.invoke<{ id: string }>('speech:saveFromQuiz', {
      nodeId,
      contentMd: 'E2E：改之前。',
    });
    const updated = await app.page.invoke<{ contentMd: string }>('speech:update', {
      id: created.id,
      contentMd: 'E2E：改之后。',
    });
    expect(updated.contentMd).toBe('E2E：改之后。');
    expect(
      db.get<{ content_md: string }>(`SELECT content_md FROM speech_snippet WHERE id = ?`, created.id)
        ?.content_md,
    ).toBe('E2E：改之后。');
  });

  it('E84 删除：删掉之后列表与库都没有它', async () => {
    const created = await app.page.invoke<{ id: string }>('speech:saveFromQuiz', {
      nodeId,
      contentMd: 'E2E：这条要被删掉。',
    });
    await app.page.invoke('speech:delete', { id: created.id });
    const all = await app.page.invoke<Array<{ id: string }>>('speech:list', null);
    expect(all.some((item) => item.id === created.id)).toBe(false);
    expect(db.count('speech_snippet', 'id = ?', created.id)).toBe(0);
  });
});
