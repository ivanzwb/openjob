/**
 * E150–E156 边界与失败路径。
 *
 * 这一组的价值不在「happy path 还能走」，而在**失败时用户看到什么、盘上留下什么**：
 * 缺包要引导而不是空题目，模型挂了要可读的错误且不留半截行，越界与超限要报错而不是
 * 悄悄给个截断的结果。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, sleep, type AppInstance } from '../harness/app';
import { AppDb } from '../harness/db';
import {
  layDownBundle,
  makeEnv,
  SE_VERSION,
  SOFTWARE_ENGINEERING,
  tamperBundle,
  type Env,
} from '../harness/env';
import { seedCampaign, seedReadyCampaign, type SeededCampaign } from '../harness/seed';
import { LlmStub } from '../harness/stub';
import { activeText, clickNav, errorText, waitActiveText } from '../harness/ui';

const PLUGIN_ID = SOFTWARE_ENGINEERING;

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('E150 缺岗位包', () => {
  let app: AppInstance;
  let env: Env;
  let seeded: SeededCampaign;

  beforeAll(async () => {
    env = makeEnv('err-nopack', { plugins: [] });
    app = await launchApp({ userData: env.userData });
    seeded = await seedCampaign(app);
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('E150 没有岗位包时：钉画像失败、出题报缺包，而不是给一道空题目', async () => {
    const profileError = await messageOf(() =>
      app.page.invoke('campaign:setRoleProfile', {
        campaignId: seeded.campaignId,
        roleFamily: 'software',
        rolePackId: PLUGIN_ID,
        level: '中级',
      }),
    );
    expect(profileError).not.toBe('');

    const createError = await messageOf(() =>
      app.page.invoke('practice:createSession', {
        campaignId: seeded.campaignId,
        examForm: 'selfIntro',
      }),
    );
    // 有岗位包时这条路是能走的（E72 已证），所以这条断言真的在测「缺包」
    expect(createError).toMatch(/描述符|岗位包/);

    await clickNav(app, '模拟面试');
    await waitActiveText(app, '模拟面试', '模拟面试页');
    const text = await activeText(app);
    expect(text).toMatch(/岗位包|还没有备考|先去/);
  });
});

describe('E151 模型失败 / 截断', () => {
  let app: AppInstance;
  let env: Env;
  let stub: LlmStub;
  let db: AppDb;

  beforeAll(async () => {
    stub = new LlmStub();
    await stub.start();
    env = makeEnv('err-model', { llmBaseUrl: stub.baseUrl, searchEndpoint: stub.searchEndpoint });
    app = await launchApp({ userData: env.userData });
    db = AppDb.open(join(env.userData, 'openjob.db'));
    await seedReadyCampaign(app);
    await clickNav(app, '模拟面试');
    await waitActiveText(app, '模拟面试', '模拟面试页');
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await app?.stop();
    await stub?.stop();
  });

  it('E151a 端点 500：给出可读错误，且不留下半截会话', async () => {
    stub.clearFailure();
    stub.alwaysFail('本次只出一道题', 'http-500');
    const before = db.count('practice_session');

    await app.page.evaluate(`(() => {
      const panel = document.querySelector('main > div:not(.hidden)');
      const button = [...panel.querySelectorAll('button')].find((b) => /开始练习|换一题/.test(b.textContent));
      button.click();
    })()`);

    const error = await app.page.waitUntil(() => errorText(app), '模型失败提示', 180_000);
    expect(error.length).toBeGreaterThan(0);
    expect(db.count('practice_session')).toBe(before);
    stub.clearFailure();
  }, 240_000);

  it('E151b 输出被截断：报「截断」而不是把残缺内容当完整交付', async () => {
    stub.clearFailure();
    stub.alwaysFail('本次只出一道题', 'truncated-json');
    const before = db.count('practice_session');

    await app.page.evaluate(`(() => {
      const panel = document.querySelector('main > div:not(.hidden)');
      const button = [...panel.querySelectorAll('button')].find((b) => /开始练习|换一题/.test(b.textContent));
      button.click();
    })()`);

    const error = await app.page.waitUntil(() => errorText(app), '截断提示', 180_000);
    expect(error).toContain('截断');
    expect(db.count('practice_session')).toBe(before);
    stub.clearFailure();
  }, 240_000);

  it('E151c 恢复后照常出题（错误路径没有把链路弄坏）', async () => {
    stub.clearFailure();
    const before = await activeText(app);
    await app.page.evaluate(`(() => {
      const panel = document.querySelector('main > div:not(.hidden)');
      [...panel.querySelectorAll('button')].find((b) => /开始练习|换一题/.test(b.textContent)).click();
    })()`);
    await app.page.waitUntil(async () => {
      const text = await activeText(app);
      return text.length > 20 && text !== before && /60-90 秒/.test(text) ? text : '';
    }, '恢复正常出题', 120_000);
    expect(await errorText(app)).toBe('');
  }, 240_000);
});

describe('E152–E153 工作区越界与超限', () => {
  let app: AppInstance;
  let env: Env;

  beforeAll(async () => {
    env = makeEnv('err-workspace');
    app = await launchApp({ userData: env.userData });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
  });

  const workspace = (): string => join(env.userData, 'plugin-workspace', PLUGIN_ID);

  it('E152 越界路径与符号链接逃逸都读不到', async () => {
    mkdirSync(workspace(), { recursive: true });
    writeFileSync(join(workspace(), 'inside.txt'), '这是工作区内的内容', 'utf8');
    const outside = join(env.userData, 'outside-secret.txt');
    writeFileSync(outside, '工作区外的机密', 'utf8');

    // 先证明正常路径是通的，否则下面的「读不到」说明不了任何事
    const inside = await app.page.invoke<string>('pluginRuntime:workspace.read', {
      pluginId: PLUGIN_ID,
      path: 'inside.txt',
    });
    expect(inside).toContain('工作区内的内容');

    for (const path of ['../outside-secret.txt', '..\\outside-secret.txt', outside]) {
      const error = await messageOf(() =>
        app.page.invoke('pluginRuntime:workspace.read', { pluginId: PLUGIN_ID, path }),
      );
      expect(error).not.toBe('');
      // 错误里不能把调用方给的路径原样带出来
      expect(error).not.toContain('outside-secret');
    }

    // 符号链接指向工作区外：同样拒绝
    const link = join(workspace(), 'escape-link');
    rmSync(link, { force: true });
    try {
      symlinkSync(outside, link);
    } catch {
      return; // 没有创建符号链接的权限（Windows 普通用户）时跳过这一段
    }
    const linkError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.read', { pluginId: PLUGIN_ID, path: 'escape-link' }),
    );
    expect(linkError).not.toBe('');
  });

  it('E153 超限一律报错，不返回被截断的结果', async () => {
    // 写超限
    const big = 'x'.repeat(256 * 1024 + 10);
    const writeError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.write', {
        pluginId: PLUGIN_ID,
        path: 'too-big.txt',
        content: big,
      }),
    );
    expect(writeError).toContain('上限');
    expect(existsSync(join(workspace(), 'too-big.txt'))).toBe(false);

    // 读超限：直接落一个超过上限的文件（写原语本来就写不进去这么大的）
    writeFileSync(join(workspace(), 'big.txt'), 'y'.repeat(300 * 1024), 'utf8');
    const readError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.read', { pluginId: PLUGIN_ID, path: 'big.txt' }),
    );
    expect(readError).toContain('上限');

    // glob 结果数超限（上限 200）
    for (let index = 0; index <= 200; index += 1) {
      await app.page.invoke('pluginRuntime:workspace.write', {
        pluginId: PLUGIN_ID,
        path: `many/f${index}.md`,
        content: 'x',
      });
    }
    const globError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.glob', { pluginId: PLUGIN_ID, pattern: 'many/*.md' }),
    );
    expect(globError).toContain('200');

    // grep 命中数超限
    for (let index = 0; index <= 200; index += 1) {
      await app.page.invoke('pluginRuntime:workspace.write', {
        pluginId: PLUGIN_ID,
        path: `hits/h${index}.txt`,
        content: 'HIT\n',
      });
    }
    const grepError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.grep', { pluginId: PLUGIN_ID, pattern: 'HIT' }),
    );
    expect(grepError).toContain('200');

    // 列目录条目超限（上限 1000）
    for (let index = 0; index <= 1000; index += 1) {
      await app.page.invoke('pluginRuntime:workspace.write', {
        pluginId: PLUGIN_ID,
        path: `flat/e${index}.txt`,
        content: 'x',
      });
    }
    const listError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.list', { pluginId: PLUGIN_ID, path: 'flat' }),
    );
    expect(listError).toContain('1000');
  }, 300_000);
});

describe('E154–E156 插件准入与隔离', () => {
  let app: AppInstance;
  let env: Env;

  beforeAll(async () => {
    env = makeEnv('err-plugin');
    // 布一份被篡改的同名包（签名与内容对不上）
    layDownBundle(env.pluginsDir, `${PLUGIN_ID}@1.0.1.ojb`, tamperBundle(PLUGIN_ID, SE_VERSION));
    app = await launchApp({ userData: env.userData });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
  });

  it('E154 被篡改的包不进装载清单，列在「被拒」里且能删掉', async () => {
    const inventory = await app.page.invoke<{
      installed: Array<{ id: string; version: string }>;
      rejected: Array<{ dir: string; reason?: string }>;
    }>('plugin:inventory', null);

    expect(inventory.rejected.some((item) => item.dir.includes('1.0.1'))).toBe(true);
    expect(inventory.installed.some((item) => item.version === '1.0.1')).toBe(false);

    const removed = await app.page.invoke<{ removed: boolean }>('plugin:removeRejectedDir', {
      dir: `${PLUGIN_ID}@1.0.1`,
    });
    expect(removed.removed).toBe(true);
    expect(existsSync(join(env.pluginsDir, `${PLUGIN_ID}@1.0.1`))).toBe(false);
  });

  it('E155 存量机器上的多份包照常装载（限制挡的是新安装，不是既有盘面）', async () => {
    // 安装入口是原生文件对话框（渲染层传不了路径），E2E 到不了那一步；
    // 这里断言的是文档里写明的另一条路：升级上来的盘面必须照常可用
    const inventory = await app.page.invoke<{ installed: Array<{ id: string; version: string }> }>(
      'plugin:inventory',
      null,
    );
    expect(inventory.installed.map((i) => i.id)).toContain(PLUGIN_ID);
  });

  it('E156 插件页抛错不会把宿主带崩', async () => {
    await clickNav(app, '源码');
    const frame = await app.waitForFrame();
    await sleep(1500);

    await frame
      .evaluate(`(() => { setTimeout(() => { throw new Error('E2E 注入的插件页异常'); }, 0); return 1; })()`)
      .catch(() => undefined);
    await sleep(500);

    // 宿主照常应答
    const campaigns = await app.page.invoke<unknown[]>('campaign:list', null);
    expect(Array.isArray(campaigns)).toBe(true);
    await clickNav(app, '总览');
    await waitActiveText(app, '备考总览', '总览页');
  });
});
