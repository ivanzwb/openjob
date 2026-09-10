import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 应用启动冒烟：以 OPENJOB_SMOKE=1 拉起真实 Electron 主进程，
 * 走完整启动链（userData 初始化 → DB 迁移 → IPC 注册 → 同步服务 →
 * 建窗并加载 renderer），等待 main 进程打出 OPENJOB_SMOKE_OK 后判通过。
 *
 * 任何一步启动链断裂（迁移失败、handler 注册抛错、renderer 加载失败）
 * 都会让进程提前退出或打出 OPENJOB_SMOKE_FAIL，本脚本据此返回非零。
 *
 * 用法：先 pnpm build（依赖 out/ 产物），再 pnpm run smoke:app。
 * 本地桌面环境下可直接运行；CI 用 xvfb-run 包一层。
 */

const require_ = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// electron 包的主入口导出二进制路径（跨平台：win 上是 .exe）
const electronPath = require_('electron');
const timeoutMs = Number(process.env['SMOKE_TIMEOUT_MS'] ?? 60_000);

// CI runner（rootless Docker / GitHub Actions）常缺 SUID sandbox 配置
// （chrome-sandbox 需 root:4755），Electron 会直接 FATAL 退出。冒烟只验证
// 启动链（DB/IPC/sync/renderer），与 sandbox 无关，CI 下显式关掉。
const args = process.env['CI'] ? ['--no-sandbox', projectRoot] : [projectRoot];

console.log(`[smoke] launching electron: ${electronPath}`);
console.log(`[smoke] timeout: ${timeoutMs}ms`);

const child = spawn(electronPath, args, {
  env: {
    ...process.env,
    OPENJOB_SMOKE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
let settled = false;

function finish(ok, reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (ok) {
    console.log(`[smoke] PASS — ${reason}`);
    child.kill();
    process.exit(0);
  } else {
    console.error(`[smoke] FAIL — ${reason}`);
    child.kill();
    process.exit(1);
  }
}

const timer = setTimeout(() => {
  finish(false, `超时 ${timeoutMs}ms 未收到 OPENJOB_SMOKE_OK`);
}, timeoutMs);

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (output.includes('OPENJOB_SMOKE_OK')) finish(true, '启动链完整（DB/IPC/sync/renderer 全通）');
  if (output.includes('OPENJOB_SMOKE_FAIL')) finish(false, '启动链某环节失败（见上方日志）');
});

child.stderr.on('data', (chunk) => process.stderr.write(chunk));

child.on('error', (err) => {
  finish(false, `无法启动 electron: ${err.message}`);
});

child.on('exit', (code) => {
  // 进程提前退出（非零）视为启动失败；正常退出且已打标由 finish 处理
  if (!settled) {
    finish(false, `electron 提前退出，code=${code}（启动链断裂或单实例锁冲突）`);
  }
});