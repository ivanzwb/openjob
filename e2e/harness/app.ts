/**
 * 真实 Electron 实例的启动与驱动。
 *
 * 每份 userData 一个实例：`--user-data-dir` 把它指到隔离副本，`--remote-debugging-port`
 * 开出 CDP。单实例锁按 userData 隔离，所以用例之间、用例与用户手上的应用之间都不打架。
 *
 * 驱动走 CDP 而不是 Playwright：这里要连两个 target——主页面（`type: page`）与插件页所在的
 * 沙箱 iframe（`type: iframe`，`about:srcdoc`），后者普通选择器根本够不到。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：harness/ 在 e2e/ 下，往上两级；不依赖 cwd，从哪儿跑都一样 */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DESKTOP_DIR = join(REPO_ROOT, 'desktop');
const require_ = createRequire(join(DESKTOP_DIR, 'package.json'));
const ELECTRON = require_('electron') as string;

export interface ConsoleEntry {
  level: string;
  text: string;
}

/** 一个 CDP 连接：一次 Runtime/Log 订阅 + 一组求值助手 */
export class CdpSession {
  private seq = 0;
  private readonly pending = new Map<number, (msg: CdpMessage) => void>();
  readonly console: ConsoleEntry[] = [];
  readonly exceptions: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data as string) as CdpMessage;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = msg.params?.['args'] as Array<Record<string, unknown>> | undefined;
        this.console.push({
          level: String(msg.params?.['type'] ?? 'log'),
          text: (args ?? [])
            .map((a) => (a['value'] ?? a['description'] ?? a['unserializableValue'] ?? '') as string)
            .join(' '),
        });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.['exceptionDetails'] as Record<string, unknown> | undefined;
        const ex = details?.['exception'] as Record<string, unknown> | undefined;
        this.exceptions.push(String(ex?.['description'] ?? details?.['text'] ?? 'unknown'));
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP 连接失败：${wsUrl}`)), {
        once: true,
      });
    });
    const session = new CdpSession(ws);
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    return session;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里求值；抛出的异常原样带回来，便于定位 */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const details = message.result?.['exceptionDetails'] as Record<string, unknown> | undefined;
    if (details) {
      const ex = details['exception'] as Record<string, unknown> | undefined;
      throw new Error(`页面求值报错：${String(ex?.['description'] ?? details['text'])}`);
    }
    return message.result?.['result']?.['value'] as T;
  }

  /** 走渲染层同一条桥：window.api.invoke（preload 白名单里登记过的通道） */
  async invoke<T = unknown>(channel: string, payload: unknown = null): Promise<T> {
    const result = await this.evaluate<{ ok: boolean; value?: T; error?: string }>(
      `(async () => {
         try {
           return { ok: true, value: await window.api.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}) };
         } catch (error) {
           return { ok: false, error: error instanceof Error ? error.message : String(error) };
         }
       })()`,
    );
    if (!result.ok) throw new Error(`invoke ${channel} 失败：${result.error}`);
    return result.value as T;
  }

  async waitFor(expression: string, options: { timeout?: number; label?: string } = {}): Promise<void> {
    const timeout = options.timeout ?? 20_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      if (Date.now() > deadline) throw new Error(`等待超时（${timeout}ms）：${options.label ?? expression}`);
      await sleep(200);
    }
  }

  async waitUntil<T>(fn: () => Promise<T | null | undefined | ''>, label: string, timeout = 120_000): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await fn();
      if (value) return value as T;
      if (Date.now() > deadline) throw new Error(`等待超时（${timeout}ms）：${label}`);
      await sleep(400);
    }
  }

  close(): void {
    this.ws.close();
  }
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface AppInstance {
  readonly userData: string;
  /** 主页面（渲染层） */
  readonly page: CdpSession;
  /** 插件页的沙箱 iframe；页签没挂载过时为 null，用 frameTarget() 等它出现 */
  frame(): CdpSession | null;
  /** 等插件页 iframe 出现并连上 */
  waitForFrame(): Promise<CdpSession>;
  targets(): Promise<Array<{ type: string; url: string }>>;
  /** 应用启动期间主进程的输出，断言启动失败时用 */
  output(): string;
  stop(): Promise<void>;
}

export async function launchApp(options: {
  /**
   * 隔离副本目录。**省略时不传 `--user-data-dir`**：那是给「userData 目录名钉死在
   * openjob」这类用例用的，配合 env.APPDATA 照样隔离，只是走应用自己的命名推导。
   */
  userData?: string;
  port?: number;
  env?: Record<string, string>;
}): Promise<AppInstance> {
  const port = options.port ?? 9400 + Math.floor(Math.random() * 400);
  const child = spawn(
    ELECTRON,
    [
      DESKTOP_DIR,
      ...(options.userData ? [`--user-data-dir=${options.userData}`] : []),
      `--remote-debugging-port=${port}`,
    ],
    {
      cwd: DESKTOP_DIR,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));

  const pageTarget = await waitForTarget(port, (t) => t.type === 'page', 60_000, child, () => output);
  const page = await CdpSession.connect(pageTarget.webSocketDebuggerUrl);
  await page.waitFor(`document.querySelectorAll('header nav button').length >= 3`, {
    timeout: 60_000,
    label: '渲染层挂载',
  });

  let frameSession: CdpSession | null = null;

  return {
    userData: options.userData ?? '',
    page,
    frame: () => frameSession,
    waitForFrame: async () => {
      if (frameSession) return frameSession;
      const target = await waitForTarget(port, (t) => t.type === 'iframe', 60_000, child, () => output);
      frameSession = await CdpSession.connect(target.webSocketDebuggerUrl);
      return frameSession;
    },
    targets: async () => {
      const list = await fetchTargets(port);
      return list.map((t) => ({ type: t.type, url: t.url }));
    },
    output: () => output,
    stop: async () => {
      page.close();
      frameSession?.close();
      killTree(child);
      // 等进程真的退出再放行：下一例常常用同一个 userData 起新实例，
      // 上一个还没退干净时单实例锁会把新的顶掉，报出来是「实例提前退出」这种假故障
      const deadline = Date.now() + 15_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await sleep(200);
      }
      await sleep(300);
    },
  };
}

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function fetchTargets(port: number): Promise<Target[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    return (await res.json()) as Target[];
  } catch {
    return [];
  }
}

async function waitForTarget(
  port: number,
  match: (target: Target) => boolean,
  timeout: number,
  child: ChildProcess,
  output: () => string,
): Promise<Target> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = (await fetchTargets(port)).find(match);
    if (found) return found;
    if (child.exitCode !== null) {
      throw new Error(`实例提前退出（code=${child.exitCode}）：\n${output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 CDP target 超时（${timeout}ms）\n${output()}`);
    }
    await sleep(250);
  }
}

/** Windows 上 child.kill() 只杀直接子进程，主进程的 renderer/gpu 子进程会留下 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGKILL');
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RawProcess {
  child: ChildProcess;
  output(): string;
  /** 等到输出里出现某个标记；超时抛错并带上已捕获的输出 */
  waitForOutput(marker: string | RegExp, timeoutMs?: number): Promise<string>;
  /** 直接退出码：用来断言「第二个实例被单实例锁挡住」 */
  exited(): number | null;
  stop(): void;
}

/** 原样起一个应用进程，不做 CDP 连接——给启动链与单实例锁这类用例用 */
export function spawnApp(userData: string, env: Record<string, string> = {}): RawProcess {
  const child = spawn(ELECTRON, [DESKTOP_DIR, `--user-data-dir=${userData}`], {
    cwd: DESKTOP_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return {
    child,
    output: () => output,
    exited: () => child.exitCode,
    waitForOutput: async (marker, timeoutMs = 90_000) => {
      const deadline = Date.now() + timeoutMs;
      const matches = (): boolean =>
        typeof marker === 'string' ? output.includes(marker) : marker.test(output);
      for (;;) {
        if (matches()) return output;
        if (child.exitCode !== null) {
          throw new Error(`进程已退出（code=${child.exitCode}），输出里没有 ${String(marker)}：\n${output}`);
        }
        if (Date.now() > deadline) throw new Error(`等待输出超时：${String(marker)}\n${output}`);
        await sleep(200);
      }
    },
    stop: () => killTree(child),
  };
}

/** 启动冒烟：OPENJOB_SMOKE=1 走完整启动链，打标即通过（与 pnpm smoke:app 同一条路） */
export async function runSmoke(): Promise<string> {
  const process_ = spawnApp(join(REPO_ROOT, 'e2e', '.runs', 'smoke'), { OPENJOB_SMOKE: '1' });
  try {
    return await process_.waitForOutput(/OPENJOB_SMOKE_(OK|FAIL)/, 90_000);
  } finally {
    process_.stop();
  }
}
