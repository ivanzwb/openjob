import { LegacyImportError } from './db/legacyImport';

/**
 * 启动链失败时的统一出口。
 *
 * DB 打开/迁移/旧库导入挂在 app.whenReady().then(...) 上，之前没有 catch：
 * 任何一步抛错都会变成未处理的 Promise 拒绝，应用「半启动」——窗口可能都不建，
 * 但进程还留着，而且如果失败发生在迁移中途，磁盘上可能躺着一个改到一半的库。
 *
 * 这里把它收敛成一个函数：一律记日志、弹一个说明性对话框（冒烟模式下改成打标记）、
 * 然后以非零码退出。退出前不再做任何写库动作，保证「要么整体成功、要么原样停下」。
 */

export interface StartupFailureIo {
  showErrorBox: (title: string, body: string) => void;
  log: (message: string) => void;
  exit: (code: number) => void;
  /** 冒烟模式不弹窗（无头），改成打 OPENJOB_SMOKE_FAIL 让启动脚本据此判失败。 */
  smoke: boolean;
}

/** 生成给用户看的失败说明；旧库导入失败时消息里已带上备份路径。 */
export function formatStartupFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof LegacyImportError) {
    // 备份路径单独再点一次：message 里通常已带，但即便换过措辞也保证用户能拿到它。
    return (
      `OpenJob 无法完成从 0.6.x 旧数据库的升级，已停止启动。\n\n${message}\n\n` +
      `升级前的完整副本：${error.backupFile}`
    );
  }
  return `OpenJob 启动时无法打开数据库，已停止启动以免留下不一致的数据。\n\n${message}`;
}

export function reportStartupFailure(error: unknown, io: StartupFailureIo): void {
  const body = formatStartupFailure(error);
  io.log(`[startup] ${body}`);
  if (io.smoke) {
    io.log(`OPENJOB_SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  } else {
    io.showErrorBox('OpenJob 启动失败', body);
  }
  io.exit(1);
}
