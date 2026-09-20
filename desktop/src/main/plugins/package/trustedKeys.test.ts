/**
 * 随包分发的第一方公钥。
 *
 * 这份文件是「哪些签名不用问用户」的唯一来源：它空了或者坏了，所有签名都只能算
 * unknown-signer——本该第一方可信的包会在用户那边弹确认，而开发期一切照旧，没人会
 * 注意到。所以这里把它当产物而非配置来体检：必须存在、必须有钥匙、钥匙必须真能用。
 *
 * 写入这份文件是安装流程之外的事（发布与手工配置），测试一律注入公钥，不碰它：
 * 并行跑的测试互相覆盖过一次，测完留下的测试密钥被提交进来，第一方签名因此全部失效。
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustedPublicKeys } from './trustedKeys';

const RESOURCES_DIR = join(__dirname, '..', '..', '..', '..', 'resources');

describe('第一方信任列表', () => {
  it('随包分发的 plugin-keys.json 在，且至少有一把钥匙', () => {
    expect(loadTrustedPublicKeys([RESOURCES_DIR]).length).toBeGreaterThan(0);
  });

  it('每把钥匙都是一把可用的 Ed25519 公钥', () => {
    for (const pem of loadTrustedPublicKeys([RESOURCES_DIR])) {
      expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519');
    }
  });

  it('文件是给人改的：换钥匙要能一眼看出换了哪把', () => {
    // 单个长行与测试写出来的压缩 JSON 无法区分，出事故时看不出被覆盖过
    const raw = readFileSync(join(RESOURCES_DIR, 'plugin-keys.json'), 'utf8');
    expect(raw.split('\n').length).toBeGreaterThan(1);
  });
});
