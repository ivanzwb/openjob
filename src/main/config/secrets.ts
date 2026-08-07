import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * API Key 存储。经 safeStorage（走系统密钥链 / DPAPI）加密后落盘，
 * 与 config.json 分离——配置类型里根本没有存明文 key 的字段。
 */

interface SecretsFile {
  /** ref -> base64(密文)；encrypted 为 false 时是 base64(明文) */
  entries: Record<string, string>;
  encrypted: boolean;
}

let cache: SecretsFile | null = null;

function file(): string {
  return join(app.getPath('userData'), 'secrets.json');
}

function load(): SecretsFile {
  if (cache) return cache;
  const path = file();
  if (!existsSync(path)) {
    cache = { entries: {}, encrypted: safeStorage.isEncryptionAvailable() };
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(path, 'utf8')) as SecretsFile;
  } catch {
    // 文件损坏时不阻塞启动，用户重新填一次 Key 即可
    cache = { entries: {}, encrypted: safeStorage.isEncryptionAvailable() };
  }
  return cache;
}

function persist(data: SecretsFile): void {
  cache = data;
  writeFileSync(file(), JSON.stringify(data, null, 2), 'utf8');
}

export function setSecret(ref: string, value: string): void {
  const data = load();
  const canEncrypt = safeStorage.isEncryptionAvailable();

  if (!value) {
    delete data.entries[ref];
    persist(data);
    return;
  }

  data.entries[ref] = canEncrypt
    ? safeStorage.encryptString(value).toString('base64')
    : Buffer.from(value, 'utf8').toString('base64');
  data.encrypted = canEncrypt;
  persist(data);
}

export function getSecret(ref: string): string | null {
  const data = load();
  const raw = data.entries[ref];
  if (!raw) return null;

  const buf = Buffer.from(raw, 'base64');
  if (!data.encrypted) return buf.toString('utf8');

  try {
    return safeStorage.decryptString(buf);
  } catch {
    // 换机器或系统密钥链变更后无法解密，视作未配置
    return null;
  }
}

export function hasSecret(ref: string): boolean {
  return Boolean(load().entries[ref]);
}

export function deleteSecret(ref: string): void {
  const data = load();
  delete data.entries[ref];
  persist(data);
}

/** safeStorage 不可用时（部分 Linux 桌面环境）需要在 UI 上提示用户 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
