/**
 * artifact 原语的边界（分发计划 §11.3 阶段 1 验收原文）：未授权、无用户选择、上限三类。
 *
 * 最核心的是「用户显式提供」——原语**不接收路径**，唯一的来源是选择器；
 * 没有用户选择就读不出任何东西，这是它与工作区原语的本质区别。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { userData: '' };

// pluginArtifact 走 electron 的 dialog；测试里只注入 select 夹具，dialog 不会被调到
vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

import type { PluginPermissionGateway } from './permissionGateway';
import {
  ARTIFACT_LIMITS,
  ArtifactAccessDeniedError,
  ArtifactError,
  ArtifactSelectionCanceledError,
  artifactRead,
} from './pluginArtifact';
import { pluginWorkspaceRoot } from './pluginWorkspace';

const ALLOW: PluginPermissionGateway = {
  authorizePlugin: () => ({ allowed: true, pluginId: 'demo.pack', permission: 'artifact:read' }),
};
const DENY: PluginPermissionGateway = {
  authorizePlugin: () => ({
    allowed: false,
    code: 'permission-undeclared',
    message: 'Capability did not declare the requested permission.',
  }),
};

let dir: string;

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'openjob-artifact-userdata-'));
  dir = mkdtempSync(join(tmpdir(), 'openjob-artifact-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(state.userData, { recursive: true, force: true });
});

/** 跑一次调用并取回它抛出的 ArtifactError.code；没抛就失败。 */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ArtifactError) return error.code;
    throw error;
  }
  throw new Error('期望抛错，但调用成功返回了');
}

describe('用户显式提供（正常路径）', () => {
  it('选中 CSV 后读入文本 / 表格，带 basename、摘要与网格', async () => {
    const file = join(dir, 'sales.csv');
    writeFileSync(file, 'name,amount\n甲公司,100\n乙公司,200\n');

    const artifact = await artifactRead('demo.pack', {
      permissionGateway: ALLOW,
      select: () => file,
    });

    // 只带 basename，不带本机目录
    expect(artifact.name).toBe('sales.csv');
    expect(artifact.name).not.toContain(dir);
    expect(artifact.format).toBe('delimited');
    expect(artifact.rows).toEqual([
      ['name', 'amount'],
      ['甲公司', '100'],
      ['乙公司', '200'],
    ]);
    expect(artifact.text).toContain('甲公司');
    expect(artifact.bytes).toBeGreaterThan(0);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('纯文本文档按行读入（每行一个单元格）；不落进本包工作区', async () => {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, '第一行\n第二行');

    const artifact = await artifactRead('demo.pack', {
      permissionGateway: ALLOW,
      select: () => file,
    });

    expect(artifact.format).toBe('text');
    expect(artifact.rows).toEqual([['第一行'], ['第二行']]);
    // 只读：原语不写工作区
    expect(existsSync(pluginWorkspaceRoot('demo.pack'))).toBe(false);
  });
});

describe('没有用户选择就不能读', () => {
  it('选择器取消即拒（原语的显式动作不成立）', async () => {
    await expect(
      artifactRead('demo.pack', { permissionGateway: ALLOW, select: () => null }),
    ).rejects.toBeInstanceOf(ArtifactSelectionCanceledError);
  });

  it('调用方给不了路径：access 上塞的 path 不参与决策', async () => {
    const access = {
      permissionGateway: ALLOW,
      select: () => null,
      path: join(dir, 'secret.txt'),
    };
    // 就算硬塞一个 path，原语也只看选择器；选择器返回 null 就拒
    await expect(artifactRead('demo.pack', access)).rejects.toBeInstanceOf(
      ArtifactSelectionCanceledError,
    );
  });
});

describe('未授权即拒', () => {
  it('未声明 artifact:read 时被拒，且不弹选择器、不带出路径', async () => {
    const select = vi.fn(() => join(dir, 'x.txt'));
    let error: unknown;
    try {
      await artifactRead('demo.pack', { permissionGateway: DENY, select });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArtifactAccessDeniedError);
    expect(select).not.toHaveBeenCalled();
    expect((error as Error).message).not.toContain(dir);
  });
});

describe('超限即报错（不静默截断）', () => {
  it('文件大小超过上限报错', async () => {
    const file = join(dir, 'big.txt');
    writeFileSync(file, 'a'.repeat(ARTIFACT_LIMITS.readBytes + 1));
    expect(
      await codeOf(() =>
        artifactRead('demo.pack', { permissionGateway: ALLOW, select: () => file }),
      ),
    ).toBe('read-limit');
  });

  it('行数超过上限报错', async () => {
    const file = join(dir, 'rows.txt');
    const lines = Array.from({ length: ARTIFACT_LIMITS.maxRows + 1 }, () => 'x');
    writeFileSync(file, lines.join('\n'));
    expect(
      await codeOf(() =>
        artifactRead('demo.pack', { permissionGateway: ALLOW, select: () => file }),
      ),
    ).toBe('row-limit');
  });

  it('单元格总数超过上限报错', async () => {
    const file = join(dir, 'cells.csv');
    const row = Array.from({ length: ARTIFACT_LIMITS.maxCells + 1 }, () => 'x');
    writeFileSync(file, row.join(','));
    expect(
      await codeOf(() =>
        artifactRead('demo.pack', { permissionGateway: ALLOW, select: () => file }),
      ),
    ).toBe('cell-limit');
  });

  it('单格字符数超过上限报错（只对分隔文件）', async () => {
    const file = join(dir, 'cell.csv');
    writeFileSync(file, `a,${'x'.repeat(ARTIFACT_LIMITS.maxCellChars + 1)}`);
    expect(
      await codeOf(() =>
        artifactRead('demo.pack', { permissionGateway: ALLOW, select: () => file }),
      ),
    ).toBe('cell-length-limit');
  });

  it('二进制文件如实拒（解析交给包自己）', async () => {
    const file = join(dir, 'book.xlsx');
    writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    expect(
      await codeOf(() =>
        artifactRead('demo.pack', { permissionGateway: ALLOW, select: () => file }),
      ),
    ).toBe('binary');
  });
});
