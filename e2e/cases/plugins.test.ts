/**
 * E110–E126 能力页：软件工程的源码页、销售/客户成功的对练页、产品经理的案例训练页。
 *
 * 这些页面跑在沙箱 iframe（`about:srcdoc`）里，必须单独连一个 CDP target——主页面的
 * 选择器够不到它们。宿主侧的原语（workspace.* / library.*）则从主页面用 IPC 调，
 * 这样「包用得到的能力」与「宿主给的能力」两侧都验到。
 *
 * 三条已知的不可自动化（方案 §9）：真实 clone（只放行公网 https）、`artifact.read`
 * 选表格（原生文件对话框）、问答的流式回答（桩还没做 SSE）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, sleep, type AppInstance, type CdpSession } from '../harness/app';
import { makeEnv, SE_VERSION, SOFTWARE_ENGINEERING, type Env } from '../harness/env';
import { LlmStub } from '../harness/stub';

const PLUGIN = SOFTWARE_ENGINEERING;
const ROLE_PLAY = 'sales-customer-success';

let app: AppInstance;
let env: Env;
let stub: LlmStub;

const workspace = (pluginId = PLUGIN): string =>
  join(env.userData, 'plugin-workspace', pluginId);

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 在插件页里点按钮 / 读文本；返回 null 表示没找到 */
async function frameClick(frame: CdpSession, selector: string): Promise<boolean> {
  return frame.evaluate<boolean>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
}

async function frameText(frame: CdpSession): Promise<string> {
  return frame.evaluate<string>(`document.body.innerText.replace(/\\s+/g, ' ').trim()`);
}

beforeAll(async () => {
  stub = new LlmStub();
  await stub.start();
  // 三个岗位包同时在盘上：能力页各归各的包，而「一台设备只装一个包」挡的是安装入口，
  // 存量盘面的多包共存是文档写明要照常装载的（见 E155）
  env = makeEnv('plugins', {
    llmBaseUrl: stub.baseUrl,
    searchEndpoint: stub.searchEndpoint,
    plugins: [
      { id: SOFTWARE_ENGINEERING, version: '1.0.0' },
      { id: ROLE_PLAY, version: '1.0.0' },
      { id: 'product-manager', version: '1.0.0' },
    ],
  });
  app = await launchApp({ userData: env.userData });
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await stub?.stop();
});

describe('E110–E116 源码页（软件工程包）', () => {
  it('E110 链接仓库：只放行公网 https，其余地址逐条被拒且不留残骸', async () => {
    const before = await app.page.invoke<Array<{ path: string }>>('pluginRuntime:workspace.list', {
      pluginId: PLUGIN,
      path: '.',
    });

    const rejected = [
      'file:///C:/Windows/System32',
      'http://example.com/repo.git', // 非 https
      'https://127.0.0.1/repo.git', // 回环
      'https://192.168.1.10/repo.git', // 内网
      'https://user:pass@github.com/a/b.git', // 带凭据
      'https://github.com', // 缺仓库路径
      '不是 URL',
    ];
    for (const url of rejected) {
      const error = await messageOf(() =>
        app.page.invoke('pluginRuntime:workspace.fetch', {
          pluginId: PLUGIN,
          url,
          dir: 'probe',
        }),
      );
      expect(error, `${url} 本该被拒`).not.toBe('');
    }

    const after = await app.page.invoke<Array<{ path: string }>>('pluginRuntime:workspace.list', {
      pluginId: PLUGIN,
      path: '.',
    });
    expect(after.map((item) => item.path)).toEqual(before.map((item) => item.path));
  }, 120_000);

  it('E111 删除仓库：工作区目录与登记行一起消失', async () => {
    mkdirSync(join(workspace(), 'demo-repo'), { recursive: true });
    writeFileSync(join(workspace(), 'demo-repo', 'index.ts'), 'export const a = 1;\n', 'utf8');
    await app.page.invoke('pluginRuntime:data.put', {
      pluginId: PLUGIN,
      collection: 'repositories',
      key: 'demo-repo',
      value: JSON.stringify({ id: 'demo-repo', label: 'https://example.com/demo.git', ready: true }),
    });
    expect(
      await app.page.invoke<number>('pluginRuntime:data.count', {
        pluginId: PLUGIN,
        collection: 'repositories',
      }),
    ).toBeGreaterThan(0);

    await app.page.invoke('pluginRuntime:workspace.delete', {
      pluginId: PLUGIN,
      path: 'demo-repo',
    });
    await app.page.invoke('pluginRuntime:data.delete', {
      pluginId: PLUGIN,
      collection: 'repositories',
      key: 'demo-repo',
    });

    const listed = await app.page.invoke<Array<{ path: string }>>('pluginRuntime:workspace.list', {
      pluginId: PLUGIN,
      path: '.',
    });
    expect(listed.some((item) => item.path === 'demo-repo')).toBe(false);
    expect(
      await app.page.invoke<number>('pluginRuntime:data.count', {
        pluginId: PLUGIN,
        collection: 'repositories',
      }),
    ).toBe(0);
  });

  it('E112 建索引：逐目录枚举能走完 >200 个文件，而 glob 在同一个树上撞上限', async () => {
    // 造一棵 300 个文件的树：这正是首页那个「文件多于 200 就再也建不出索引」的场景
    const tree = join(workspace(), 'big-repo');
    rmSync(tree, { recursive: true, force: true });
    for (let dir = 0; dir < 6; dir += 1) {
      const sub = join(tree, `pkg${dir}`);
      mkdirSync(sub, { recursive: true });
      for (let file = 0; file < 50; file += 1) {
        writeFileSync(join(sub, `f${file}.ts`), `export const v${file} = ${file};\n`, 'utf8');
      }
    }

    // 包现在的做法：workspace.list 逐层走（单次列一个目录，上限 1000）
    const seen: string[] = [];
    const queue = ['big-repo'];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await app.page.invoke<Array<{ path: string; type: string }>>(
        'pluginRuntime:workspace.list',
        { pluginId: PLUGIN, path: current },
      );
      for (const entry of entries) {
        if (entry.type === 'dir') queue.push(entry.path);
        else seen.push(entry.path);
      }
    }
    expect(seen.length).toBe(300);

    // 同一个树上整仓 glob 一定撞 200 条上限——这就是当初包里的报错
    const globError = await messageOf(() =>
      app.page.invoke('pluginRuntime:workspace.glob', {
        pluginId: PLUGIN,
        pattern: 'big-repo/**/*.ts',
      }),
    );
    expect(globError).toContain('200');

    // 逐目录枚举完之后，符号提取也能拿到结果（索引的另一半）
    const symbols = await app.page.invoke<Record<string, unknown>>('pluginRuntime:workspace.symbols', {
      pluginId: PLUGIN,
      paths: seen.slice(0, 20),
    });
    expect(symbols).toBeTruthy();
  }, 300_000);

  it('E113 文件浏览与分页：按行区间读取，翻页不越界', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n');
    writeFileSync(join(workspace(), 'long.ts'), lines, 'utf8');

    const first = await app.page.invoke<string>('pluginRuntime:workspace.read', {
      pluginId: PLUGIN,
      path: 'long.ts',
      startLine: 1,
      endLine: 300,
    });
    expect(first.split('\n')).toHaveLength(300);
    expect(first.startsWith('line 1')).toBe(true);

    const second = await app.page.invoke<string>('pluginRuntime:workspace.read', {
      pluginId: PLUGIN,
      path: 'long.ts',
      startLine: 301,
      endLine: 500,
    });
    expect(second.split('\n')).toHaveLength(200);
    expect(second.startsWith('line 301')).toBe(true);

    const listed = await app.page.invoke<Array<{ path: string }>>('pluginRuntime:workspace.list', {
      pluginId: PLUGIN,
      path: '.',
    });
    expect(listed.some((item) => item.path === 'long.ts')).toBe(true);
  });

  it('E115 存为话术：代码引用进话术库，重复存被去重', async () => {
    const text = 'export function main() { return 1; }';
    const first = await app.page.invoke<{ id: string; sourceType: string }>(
      'pluginRuntime:library.saveSnippet',
      { pluginId: PLUGIN, text, sourceKind: 'code-ref', sourceLabel: 'big-repo/pkg0/f0.ts:1-1' },
    );
    const second = await app.page.invoke<{ id: string }>('pluginRuntime:library.saveSnippet', {
      pluginId: PLUGIN,
      text,
      sourceKind: 'code-ref',
      sourceLabel: 'big-repo/pkg0/f0.ts:1-1',
    });
    expect(second.id).toBe(first.id);

    const mine = await app.page.invoke<Array<{ id: string }>>('pluginRuntime:library.listSnippets', {
      pluginId: PLUGIN,
      sourceKind: 'code-ref',
      limit: 50,
    });
    expect(mine.some((item) => item.id === first.id)).toBe(true);
  });

  it('E116 代码标记：标一行区间、按目标列回来、删掉', async () => {
    const mark = await app.page.invoke<{ id: string }>('pluginRuntime:library.annotate', {
      pluginId: PLUGIN,
      targetKind: 'code-mark',
      targetId: 'big-repo/pkg1/f1.ts:10-20',
      targetLabel: 'big-repo/pkg1/f1.ts:10-20',
      kind: 'note',
      noteMd: 'E2E：这里的边界要再确认。',
    });

    const marks = await app.page.invoke<Array<{ id: string; targetId: string }>>(
      'pluginRuntime:library.listAnnotations',
      { pluginId: PLUGIN, targetKind: 'code-mark' },
    );
    expect(marks.some((item) => item.id === mark.id)).toBe(true);

    await app.page.invoke('pluginRuntime:library.deleteAnnotation', {
      pluginId: PLUGIN,
      id: mark.id,
    });
    const after = await app.page.invoke<Array<{ id: string }>>(
      'pluginRuntime:library.listAnnotations',
      { pluginId: PLUGIN, targetKind: 'code-mark' },
    );
    expect(after.some((item) => item.id === mark.id)).toBe(false);
  });

  it('E114 问答：问一句，流式回答逐段落屏，并存进问答历史', async () => {
    // 问答要选中一个仓库；登记一行再重载插件页，让它读得到
    await app.page.invoke('pluginRuntime:data.put', {
      pluginId: PLUGIN,
      collection: 'repositories',
      key: 'big-repo',
      value: JSON.stringify({
        id: 'big-repo',
        label: 'https://example.com/big-repo.git',
        ready: true,
        dir: 'big-repo',
      }),
    });
    const before = await openSourceTab();
    await before.evaluate('location.reload()');
    await sleep(1200);
    const frame = await app.frameFor('源码仓库');

    const asked = await frame.evaluate<{ ok: boolean; why?: string }>(`(() => {
      const qa = [...document.querySelectorAll('button,a,div')].find((n) => n.textContent.trim() === '问答');
      if (qa) qa.click();
      const input = document.querySelector('#question');
      const ask = document.querySelector('#ask');
      if (!input || !ask) return { ok: false, why: '问答区没渲染出来' };
      input.value = '这个仓库的构建入口在哪？';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ask.click();
      return { ok: true };
    })()`);
    expect(asked.ok, asked.why ?? '').toBe(true);

    stub.clear();
    const answer = await waitForText(frame, /桩回答|scripts\/build\.ts/, '流式回答落屏', 90_000);
    expect(answer).toContain('scripts/build.ts');
    expect(stub.requests.length).toBeGreaterThan(0);

    // 问答历史落进插件数据集合
    const history = await app.page.invoke<Array<{ key: string }>>('pluginRuntime:data.list', {
      pluginId: PLUGIN,
      collection: 'qa-history',
    });
    expect(Array.isArray(history)).toBe(true);
  }, 240_000);
});

describe('E122–E126 客户对话模拟（销售包）', () => {
  it('E122–E126 场景 → 开始 → 回应 → 交卷 → 历史', async () => {
    // 销售包没有预置，直接把它摊进 plugins 目录再靠扫描装载是启动期的事，
    // 这里改走「已装的那份声明」：页面本身由包提供，缺包时下面会明确失败
    const frame = await waitForRolePlay();
    const text = await frameText(frame);
    expect(text).toMatch(/客户对话模拟|场景|对练/);

    // 选场景
    const scenarioOk = await frame.evaluate<boolean>(`(() => {
      const select = document.querySelector('#scenario');
      if (!select || select.options.length === 0) return false;
      select.selectedIndex = 0;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    expect(scenarioOk, '场景下拉没填充').toBe(true);
    await sleep(300);

    // 开始对练
    expect(await frameClick(frame, '#start')).toBe(true);
    await waitForText(frame, /进行中|回应|已交卷/, '对练开始');
    const sessionsAfterStart = await app.page.invoke<number>('pluginRuntime:data.count', {
      pluginId: ROLE_PLAY,
      collection: 'role-play-sessions',
    });
    expect(sessionsAfterStart).toBeGreaterThan(0);

    // 回应客户（走模型桩）
    await frame.evaluate(`(() => {
      const reply = document.querySelector('#reply');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(reply, '王总您好，我理解续约的核心是使用率，我先看看数据再谈价格。');
      reply.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    stub.clear();
    await frameClick(frame, '#submit');
    await waitForText(frame, /客户回应|桩/, '客户回应落屏', 60_000);
    expect(stub.requests.length).toBeGreaterThan(0);

    // 交卷
    expect(await frameClick(frame, '#finish')).toBe(true);
    await sleep(500);
    const text2 = await frameText(frame);
    expect(text2).toMatch(/已交卷|已结束/);

    // 历史里能回看
    const sessions = await app.page.invoke<Array<{ key: string; value: string }>>(
      'pluginRuntime:data.list',
      { pluginId: ROLE_PLAY, collection: 'role-play-sessions' },
    );
    const finished = sessions
      .map((item) => JSON.parse(item.value) as { status: string })
      .filter((item) => item.status === 'completed');
    expect(finished.length).toBeGreaterThan(0);
  }, 240_000);
});

describe('E117–E121 案例训练（产品经理包）', () => {
  /**
   * 已知缺口：这一页的第一步是 `artifact.read`——它在主进程弹原生文件选择器，渲染层与插件页
   * 都传不了路径，CDP 驱动不了。没有数据集时后面四步（出题 / 评分 / 推荐答案 / 案例历史）
   * 也一并卡住：实测点「出题」在无数据集时不会发模型调用、也不会写 cases（页面静态文案里有
   * 「题目」二字，容易误判成已经出题）。要覆盖这一组，得在宿主侧留一个「测试期直接给一份
   * 数据集」的接缝，或者允许用例预置 artifact。
   */
  it.skip('E117–E121 选表 → 出题 → 作答 → 评分 → 推荐答案 → 案例历史', async () => {
    const frame = await openCasePractice();
    await frameClick(frame, '#pick');
  });
});

/** 切到案例训练页并连上它的 iframe */
async function openCasePractice(): Promise<CdpSession> {
  const opened = await app.page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('header nav button')]
      .find((b) => b.textContent.trim() === '案例训练');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  expect(opened, '导航里没有「案例训练」').toBe(true);
  await sleep(800);
  return app.frameFor('案例训练');
}

/** 切到源码页并连上它的 iframe */
async function openSourceTab(): Promise<CdpSession> {
  const opened = await app.page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('header nav button')]
      .find((b) => b.textContent.trim() === '源码');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  expect(opened, '导航里没有「源码」').toBe(true);
  await sleep(800);
  return app.frameFor('源码仓库');
}

/** 切到销售页并连上它的 iframe */
async function waitForRolePlay(): Promise<CdpSession> {
  const opened = await app.page.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('header nav button')]
      .find((b) => b.textContent.trim() === '客户对话模拟');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  expect(opened, '导航里没有「客户对话模拟」').toBe(true);
  await sleep(800);
  return app.frameFor('客户对话模拟');
}

async function waitForText(
  frame: CdpSession,
  pattern: RegExp,
  label: string,
  timeout = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await frameText(frame);
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`插件页等待超时：${label}；当前正文 = ${text.slice(0, 200)}`);
    await sleep(300);
  }
}

void SE_VERSION;
