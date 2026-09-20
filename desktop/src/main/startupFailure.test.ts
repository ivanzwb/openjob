/**
 * 启动失败的出口：必须能说明白、能被看到，且一定以非零码停下。
 *
 * DB 打开链原本挂在 app.whenReady().then(...) 上没有 catch，任何一步抛错都变成未处理的
 * Promise 拒绝。这里把「报错格式」和「弹窗/退出」两件事钉住。
 */
import { describe, expect, it } from 'vitest';
import { LegacyImportError } from './db/legacyImport';
import { formatStartupFailure, reportStartupFailure } from './startupFailure';

describe('启动失败处理', () => {
  it('旧库导入失败：消息里带上备份路径', () => {
    const error = new LegacyImportError('导入没完成', '/data/openjob/openjob.db.legacy-0.6.x.bak');
    const message = formatStartupFailure(error);
    expect(message).toContain('/data/openjob/openjob.db.legacy-0.6.x.bak');
    expect(message).toContain('导入没完成');
  });

  it('普通失败：弹窗说明原因并以非零码退出', () => {
    const shown: Array<[string, string]> = [];
    let exitCode: number | null = null;

    reportStartupFailure(new Error('database is locked'), {
      showErrorBox: (title, body) => shown.push([title, body]),
      log: () => {},
      exit: (code) => {
        exitCode = code;
      },
      smoke: false,
    });

    expect(shown).toHaveLength(1);
    expect(shown[0][1]).toContain('database is locked');
    expect(exitCode).toBe(1);
  });

  it('冒烟模式不弹窗（无头），改打 OPENJOB_SMOKE_FAIL 供启动脚本判失败', () => {
    const logs: string[] = [];
    let exitCode: number | null = null;

    reportStartupFailure(new Error('boom'), {
      showErrorBox: () => {
        throw new Error('冒烟模式下不应弹窗');
      },
      log: (message) => logs.push(message),
      exit: (code) => {
        exitCode = code;
      },
      smoke: true,
    });

    expect(logs.join('\n')).toContain('OPENJOB_SMOKE_FAIL');
    expect(exitCode).toBe(1);
  });
});
