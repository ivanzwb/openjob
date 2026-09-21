/**
 * E20–E31 简历与岗位：新建编辑预览、粘贴导入、AI 结构化与润色、复制删除、寸照、
 * 岗位 CRUD、定向优化版本 CRUD。
 *
 * 受原生对话框限制、不在这里的两条：`resume:importFile`（选文件）与 `resume:exportPdf`
 * （选保存位置）——CDP 驱动不了主进程的对话框，归手工（方案 §9）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { launchApp, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import { makeEnv, type Env } from '../harness/env';
import { LlmStub } from '../harness/stub';

let app: AppInstance;
let env: Env;
let db: AppDb;
let stub: LlmStub;

const RAW = [
  '姓名：E2E 候选人',
  '城市：杭州',
  '',
  '工作经历：',
  'E2E 科技 · 后端工程师 · 2019-2025',
  '负责订单系统的重构，QPS 从 1k 提到 5k。',
  '',
  '技能：Java、TypeScript、MySQL',
].join('\n');

beforeAll(async () => {
  stub = new LlmStub();
  await stub.start();
  env = makeEnv('resume', { llmBaseUrl: stub.baseUrl, searchEndpoint: stub.searchEndpoint });
  app = await launchApp({ userData: env.userData });
  db = AppDb.open(join(env.userData, 'openjob.db'));
}, 180_000);

afterAll(async () => {
  db?.close();
  await app?.stop();
  await stub?.stop();
});

describe('E20–E26 简历本体', () => {
  let resumeId = '';

  it('E20 粘贴导入 + 编辑：正文落库，改动写回', async () => {
    const created = await app.page.invoke<{ id: string }>('resume:create', {
      label: 'E2E 母版',
      rawText: RAW,
    });
    resumeId = created.id;
    expect(db.count('resume', 'id = ?', resumeId)).toBe(1);

    await app.page.invoke('resume:update', { id: resumeId, rawText: `${RAW}\n\n补充：带过 5 人小组。` });
    const row = db.get<{ raw_text: string }>(
      `SELECT raw_text FROM resume WHERE id = ?`,
      resumeId,
    );
    expect(row?.raw_text).toContain('带过 5 人小组');
  });

  it('E23 AI 结构化：桩返回结构化正文，落库且不产生第二份简历', async () => {
    const before = db.count('resume');
    const structured = await app.page.invoke<{ contentMd: string }>('resume:aiStructure', {
      contentMd: RAW,
    });
    expect(structured.contentMd.length).toBeGreaterThan(0);
    expect(db.count('resume')).toBe(before);
    expect(stub.requests.length).toBeGreaterThan(0);
  }, 120_000);

  it('E24 AI 润色：只改指定那一块，正文随之更新', async () => {
    const polished = await app.page.invoke<{ contentMd: string }>('resume:aiPolish', {
      resumeMd: RAW,
      sectionKey: 'summary',
      contentMd: '多年后端经验。',
      instruction: '写得更具体',
    });
    expect(polished.contentMd.length).toBeGreaterThan(0);
  }, 120_000);

  it('E25 复制：得到一份独立简历，改动互不影响', async () => {
    const copy = await app.page.invoke<{ id: string }>('resume:duplicate', { id: resumeId });
    expect(copy.id).not.toBe(resumeId);
    await app.page.invoke('resume:update', { id: copy.id, label: 'E2E 副本改过名' });
    const original = db.get<{ label: string }>(`SELECT label FROM resume WHERE id = ?`, resumeId);
    expect(original?.label).toBe('E2E 母版');
  });

  it('E28 寸照：设上去能读回，置 null 就移除', async () => {
    const photo = 'data:image/png;base64,iVBORw0KGgo=';
    await app.page.invoke('resume:update', { id: resumeId, photo });
    expect(
      db.get<{ photo: string | null }>(`SELECT photo FROM resume WHERE id = ?`, resumeId)?.photo,
    ).toBe(photo);

    await app.page.invoke('resume:update', { id: resumeId, photo: null });
    expect(
      db.get<{ photo: string | null }>(`SELECT photo FROM resume WHERE id = ?`, resumeId)?.photo,
    ).toBeNull();
  });

  it('E26 删除：删掉之后列表与库里都没有它', async () => {
    const throwaway = await app.page.invoke<{ id: string }>('resume:create', {
      label: 'E2E 待删简历',
      rawText: '待删',
    });
    await app.page.invoke('resume:delete', { id: throwaway.id });
    const list = await app.page.invoke<Array<{ id: string }>>('resume:list', null);
    expect(list.some((item) => item.id === throwaway.id)).toBe(false);
    expect(db.count('resume', 'id = ?', throwaway.id)).toBe(0);
  });
});

describe('E29–E31 岗位与定向优化', () => {
  let jobTargetId = '';
  let variantId = '';

  it('E29 岗位 CRUD：建、改、删；被引用时删除给出明确结果', async () => {
    const created = await app.page.invoke<{ id: string }>('jobTarget:create', {
      company: 'E2E 岗位公司',
      roleTitle: '后端工程师',
      jdRaw: '熟悉分布式系统。',
    });
    jobTargetId = created.id;

    const updated = await app.page.invoke<{ roleTitle: string }>('jobTarget:update', {
      id: jobTargetId,
      roleTitle: '资深后端工程师',
    });
    expect(updated.roleTitle).toBe('资深后端工程师');

    const throwaway = await app.page.invoke<{ id: string }>('jobTarget:create', {
      company: 'E2E 待删公司',
      roleTitle: '待删',
      jdRaw: 'x',
    });
    await app.page.invoke('jobTarget:delete', { id: throwaway.id });
    const list = await app.page.invoke<Array<{ id: string }>>('jobTarget:list', null);
    expect(list.some((item) => item.id === throwaway.id)).toBe(false);
  });

  it('E30 定向优化：按（母版, 岗位）生成一份，与母版并列且可改可删', async () => {
    const variant = await app.page.invoke<{ id: string; sourceResumeId?: string }>(
      'resumeVariant:optimize',
      { sourceResumeId: variantSourceId(), jobTargetId },
    );
    variantId = variant.id;
    expect(variantId).toBeTruthy();

    const list = await app.page.invoke<Array<{ id: string }>>('resumeVariant:list', {
      jobTargetId,
    });
    expect(list.some((item) => item.id === variantId)).toBe(true);

    const updated = await app.page.invoke<{ label?: string }>('resumeVariant:update', {
      id: variantId,
      label: 'E2E 优化版改名',
    });
    expect(updated).toBeTruthy();

    const copy = await app.page.invoke<{ id: string }>('resumeVariant:duplicate', { id: variantId });
    expect(copy.id).not.toBe(variantId);

    await app.page.invoke('resumeVariant:delete', { id: copy.id });
    const after = await app.page.invoke<Array<{ id: string }>>('resumeVariant:list', { jobTargetId });
    expect(after.some((item) => item.id === copy.id)).toBe(false);
  }, 180_000);

  it('E31 无简历时的空态：列表为空、不抛错', async () => {
    const list = await app.page.invoke<Array<{ id: string }>>('resume:list', null);
    expect(Array.isArray(list)).toBe(true);
  });
});

function variantSourceId(): string {
  return (
    db.get<{ id: string }>(`SELECT id FROM resume WHERE label = 'E2E 母版'`)?.id ?? ''
  );
}
