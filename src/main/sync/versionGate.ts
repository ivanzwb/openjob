import { app } from 'electron';
import {
  SYNC_VERSION_MISMATCH,
  isSyncCompatible,
  normalizeVersion,
  versionMismatchMessage,
  type SyncErrorBody,
} from '@shared/version';

/** 版本不一致时的 HTTP 状态码：请求本身没问题，是两端状态冲突 */
export const VERSION_MISMATCH_STATUS = 409;

export function localAppVersion(): string {
  return normalizeVersion(app.getVersion());
}

export interface VersionCheck {
  ok: boolean;
  /** 仅在 ok 为 false 时有值，直接作为响应体发回去 */
  body?: SyncErrorBody;
  /** 对端上报的版本，认不出时为 null；用于事件通知与日志 */
  peerVersion: string | null;
}

/**
 * 同步闸门：两端版本不同就不让这一轮进行到动数据那一步。
 *
 * 开发态（未打包）直接放行。仓库里 `package.json` 与 `mobile/app.json` 的版本号
 * 只在发布时由 tag 同步，平时本来就不一样（0.6.6 对 1.0.0），照发布态的规则拦
 * 会让本地两端永远同步不了，等于把调试链路一起掐死。
 */
export function checkPeerVersion(rawPeerVersion: string | undefined): VersionCheck {
  const peerVersion = rawPeerVersion ? normalizeVersion(rawPeerVersion) : null;
  if (!app.isPackaged) return { ok: true, peerVersion };

  const desktopVersion = localAppVersion();
  if (peerVersion && isSyncCompatible(desktopVersion, peerVersion)) {
    return { ok: true, peerVersion };
  }

  return {
    ok: false,
    peerVersion,
    body: {
      error: versionMismatchMessage(desktopVersion, peerVersion),
      code: SYNC_VERSION_MISMATCH,
      desktopVersion,
      peerVersion: peerVersion ?? undefined,
    },
  };
}
