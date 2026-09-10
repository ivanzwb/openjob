/**
 * 手机端收下岗位包的判据。
 *
 * 这条路径上不存在签名校验（手机端验不了 Ed25519），所以结构校验和版本核对是唯一的两道
 * 关。放松任何一道的后果都不是报错：手机端会按另一套题型和量规出题，而 descriptor 里的
 * configSnapshotHash 一个字都不变。
 */
import { describe, expect, it } from 'vitest';
import { PACKAGE_MANIFEST_FILE, PACKAGE_PACK_FILE, validatePluginPackage } from './contract';
import { parseTransferredRolePack, rolePackToPackageFiles } from './rolePackTransfer';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import type { RolePack } from '../types';

const PACK = DISTRIBUTED_ROLE_PACKS[0]!;
const REF = { id: PACK.manifest.id, version: PACK.manifest.version };

function clone(): RolePack {
  return structuredClone(PACK) as RolePack;
}

describe('rolePackToPackageFiles', () => {
  it('拆出的两个文件就是安装路径认的那份包，校验零问题', () => {
    const files = rolePackToPackageFiles(PACK);

    expect(Object.keys(files).sort()).toEqual([PACKAGE_MANIFEST_FILE, PACKAGE_PACK_FILE]);
    expect(validatePluginPackage(files)).toEqual([]);
    // manifest 只在 manifest.json 里出现一次，pack.json 里不该再夹一份
    expect(JSON.parse(files[PACKAGE_PACK_FILE]!)).not.toHaveProperty('manifest');
  });
});

describe('parseTransferredRolePack', () => {
  it('桌面端装着这一版时原样收下', () => {
    const result = parseTransferredRolePack(clone(), REF);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.manifest.id).toBe(REF.id);
    expect(result.pack.interviewFormats.length).toBeGreaterThan(0);
  });

  it('桌面端没装这个包时给出可读原因，而不是当成空包收下', () => {
    expect(parseTransferredRolePack(null, REF)).toMatchObject({ ok: false });
    expect(parseTransferredRolePack(undefined, REF)).toMatchObject({ ok: false });
  });

  it('版本对不上一律拒收：descriptor 固定的是精确版本', () => {
    const other = clone();
    other.manifest = { ...other.manifest, version: '9.9.9' };

    const result = parseTransferredRolePack(other, REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('9.9.9');
  });

  it('结构坏掉的包按包格式的原话拒收，不进缓存', () => {
    const broken = clone() as unknown as Record<string, unknown>;
    delete broken['rubrics'];

    const result = parseTransferredRolePack(broken, REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('rubrics');
  });

  it('内容被换成另一个岗位的数据、但 id@version 照抄时也拒收', () => {
    // 结构校验里量规、题型、能力项之间的引用必须自洽，改不动其中一半而不被发现
    const swapped = clone();
    swapped.rubrics = [];

    expect(parseTransferredRolePack(swapped, REF).ok).toBe(false);
  });
});
