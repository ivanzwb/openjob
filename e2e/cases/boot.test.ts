/**
 * E01–E08 启动与宿主：启动链、0.6.x 整库导入、迁移撞车回退、单实例锁、userData 目录名、
 * 默认插件随包安装 / 同版本内容替换 / 卸载过不复活。
 *
 * 这一组的断言大多落在**盘上**（目录、备份文件、状态文件）——启动链的问题从来不在界面里。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, REPO_ROOT, runSmoke, sleep, spawnApp, type AppInstance } from '../harness/app';
import { makeEnv, RUNS_DIR, SOFTWARE_ENGINEERING, SE_VERSION, type Env } from '../harness/env';
import { buildHalfMigratedDb, buildLegacy06Db, migrationTag } from '../harness/legacy';

let app: AppInstance | null = null;
let raw: ReturnType<typeof spawnApp> | null = null;

afterEach(async () => {
  await app?.stop();
  raw?.stop();
  app = null;
  raw = null;
});

const packDir = (env: Env): string => join(env.pluginsDir, `${SOFTWARE_ENGINEERING}@${SE_VERSION}`);

describe('E01–E03 启动链与旧库', () => {
  it('E01 冒烟启动：目录 → 迁移 → IPC → 同步 → renderer 全通', async () => {
    const output = await runSmoke();
    expect(output).toContain('OPENJOB_SMOKE_OK');
    expect(output).not.toContain('OPENJOB_SMOKE_FAIL');
  }, 180_000);

  it('E02 0.6.x 旧库走整库导入：数据到位、留下备份、再启动不重复导入', async () => {
    const env = makeEnv('boot-legacy');
    buildLegacy06Db(join(env.userData, 'openjob.db'));

    app = await launchApp({ userData: env.userData });
    const campaigns = await app.page.invoke<Array<{ id: string; company: string }>>(
      'campaign:list',
      null,
    );
    expect(campaigns.map((c) => c.company)).toContain('旧库示例科技');

    const backup = join(env.userData, 'openjob.db.legacy-0.6.x.bak');
    expect(existsSync(backup)).toBe(true);

    // 再启动一次：备份字节不变（没有第二次导入把备份覆盖掉）
    const firstBackup = readFileSync(backup);
    await app.stop();
    app = await launchApp({ userData: env.userData });
    expect(readFileSync(backup).equals(firstBackup)).toBe(true);
    const again = await app.page.invoke<Array<{ company: string }>>('campaign:list', null);
    expect(again.filter((c) => c.company === '旧库示例科技')).toHaveLength(1);
  }, 240_000);

  it('E03 半迁移库（表已最新、迁移账被截断）：启动不炸，数据照旧在', async () => {
    const env = makeEnv('boot-half');
    buildHalfMigratedDb(join(env.userData, 'openjob.db'), migrationTag(2));

    app = await launchApp({ userData: env.userData });
    const campaigns = await app.page.invoke<Array<{ company: string }>>('campaign:list', null);
    expect(campaigns.map((c) => c.company)).toContain('半迁移科技');
  }, 240_000);
});

describe('E04–E05 进程与目录', () => {
  it('E04 单实例锁：同一 userData 起第二个实例，第二个退出、第一个照常服务', async () => {
    const env = makeEnv('boot-lock');
    app = await launchApp({ userData: env.userData });

    raw = spawnApp(env.userData);
    const deadline = Date.now() + 30_000;
    while (raw.exited() === null && Date.now() < deadline) await sleep(300);
    expect(raw.exited()).not.toBeNull();
    expect(raw.output()).not.toContain('OPENJOB_SMOKE_FAIL');

    // 第一个实例没被带崩
    const campaigns = await app.page.invoke<unknown[]>('campaign:list', null);
    expect(Array.isArray(campaigns)).toBe(true);
  }, 180_000);

  it('E05 userData 目录名钉死在 openjob（不是包名推导出来的 @openjob/desktop）', async () => {
    // 不传 --user-data-dir：让应用按自己的命名推导，只把 APPDATA 指到临时目录保证隔离
    const appData = join(RUNS_DIR, 'boot-name', 'appData');
    const env = makeEnv('boot-name');
    void env;
    app = await launchApp({ env: { APPDATA: appData } });

    const paths = await app.page.invoke<{ userData: string }>('app:getPaths', null);
    expect(paths.userData.endsWith('openjob')).toBe(true);
    expect(paths.userData).not.toContain('@openjob');
    expect(existsSync(join(paths.userData, 'openjob.db'))).toBe(true);
  }, 180_000);
});

describe('E06–E08 随包分发的默认插件', () => {
  it('E06 本机没有时把它装上，并记下内容哈希', async () => {
    const env = makeEnv('boot-install', { plugins: [], dismissBundled: false });
    app = await launchApp({ userData: env.userData });

    expect(existsSync(join(packDir(env), 'manifest.json'))).toBe(true);
    const state = JSON.parse(
      readFileSync(join(env.userData, 'bundled-plugins.json'), 'utf8'),
    ) as { installed: Array<{ id: string; sha256: string }> };
    expect(state.installed.map((i) => i.id)).toContain(SOFTWARE_ENGINEERING);
    expect(state.installed[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 180_000);

  it('E07 同版本但盘上那份内容变了就换掉；内容没变则不动盘', async () => {
    const env = makeEnv('boot-replace'); // 预置的是随包那份，但还没有「上次装的是哪份」的记录
    const packJson = join(packDir(env), 'pack.json');
    const original = JSON.parse(readFileSync(packJson, 'utf8')) as Record<string, unknown>;
    writeFileSync(packJson, JSON.stringify({ ...original, _stale: true }), 'utf8');

    app = await launchApp({ userData: env.userData });
    const replaced = JSON.parse(readFileSync(packJson, 'utf8')) as Record<string, unknown>;
    expect(replaced._stale).toBeUndefined();

    // 第二次启动：内容与记录一致 → 不重写。再塞标记，重写的话标记会消失
    await app.stop();
    app = null;
    writeFileSync(packJson, JSON.stringify({ ...replaced, _stale: true }), 'utf8');
    app = await launchApp({ userData: env.userData });
    const kept = JSON.parse(readFileSync(packJson, 'utf8')) as Record<string, unknown>;
    expect(kept._stale).toBe(true);
  }, 240_000);

  it('E08 用户卸载过就不再装回来', async () => {
    const env = makeEnv('boot-dismissed', { plugins: [], dismissBundled: true });
    app = await launchApp({ userData: env.userData });
    expect(existsSync(packDir(env))).toBe(false);

    // 反过来：把记录删掉，下次启动就装回来
    await app.stop();
    app = null;
    writeFileSync(join(env.userData, 'dismissed-plugins.json'), '{"dismissed":[]}\n', 'utf8');
    app = await launchApp({ userData: env.userData });
    expect(existsSync(join(packDir(env), 'manifest.json'))).toBe(true);
  }, 240_000);
});

void REPO_ROOT;
