/**
 * 「假手机」：在桌面端看来，它就是一台扫码后连上来的对端设备。
 *
 * 配对的发起方是手机（桌面只出二维码），所以桌面端没有「加入」的 IPC——要跑通这条链路，
 * 只能自己按协议来：ping 拿版本 → pair 提交配对码换共享密钥 → exchange 带签名交换数据。
 * 签名算法取自 `desktop/src/main/sync/crypto.ts`：
 *   HMAC-SHA256(sharedKey, `${deviceId}|${timestamp}|METHOD|path|body}`) 的 base64url。
 */
import { createHmac } from 'node:crypto';

export interface PairOutcome {
  sharedKey: string;
  deviceId: string;
  displayName: string;
  appVersion: string;
}

export interface ExchangeOutcome {
  changes: { rows: Array<{ table: string; id: string }>; headSeq: number };
  appliedCount: number;
  overwriteCount: number;
}

export class FakePeer {
  readonly deviceId = 'e2e-phone';

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1',
    private readonly displayName = 'E2E 手机',
  ) {}

  private url(path: string): string {
    return `http://${this.host}:${this.port}${path}`;
  }

  async ping(): Promise<{ appVersion: string; deviceId: string }> {
    const res = await fetch(this.url('/sync/ping'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMs: Date.now() }),
    });
    if (!res.ok) throw new Error(`ping 失败：${res.status} ${await res.text()}`);
    return (await res.json()) as { appVersion: string; deviceId: string };
  }

  /** 提交配对码换共享密钥；不给版本时先由 ping 问出来，保证版本闸门能过 */
  async pair(code: string): Promise<PairOutcome> {
    return this.pairWithVersion(code, (await this.ping()).appVersion);
  }

  /** 指定版本去配对：用来验证「版本对不上时连配对都不建立」 */
  async pairWithVersion(code: string, appVersion: string): Promise<PairOutcome> {
    const res = await fetch(this.url('/sync/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceId: this.deviceId,
        displayName: this.displayName,
        platform: 'e2e',
        appVersion,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`pair 失败：${res.status} ${text}`);
    return JSON.parse(text) as PairOutcome;
  }

  /** 带签名的数据交换：发一份空变更集，把对方自 sinceSeq 之后的变更拿回来 */
  async exchange(
    sharedKey: string,
    options: { sinceSeq?: number; full?: boolean } = {},
  ): Promise<ExchangeOutcome> {
    const body = JSON.stringify({
      appVersion: (await this.ping()).appVersion,
      deviceId: this.deviceId,
      sinceSeq: options.sinceSeq ?? 0,
      clientMs: Date.now(),
      full: options.full ?? false,
      changes: { deviceId: this.deviceId, headSeq: 0, rows: [], tombstones: [] },
    });
    const timestamp = Date.now();
    const signature = createHmac('sha256', sharedKey)
      .update(`${this.deviceId}|${timestamp}|POST|/sync/exchange|${body}`)
      .digest('base64url');

    const res = await fetch(this.url('/sync/exchange'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Device-Id': this.deviceId,
        'X-Timestamp': String(timestamp),
        'X-Signature': signature,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`exchange 失败：${res.status} ${text}`);
    return JSON.parse(text) as ExchangeOutcome;
  }
}
