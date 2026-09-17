import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  getDb: vi.fn(),
  schema: {},
}));
vi.mock('./repository', () => ({
  recordCodeRefs: vi.fn(),
}));
vi.mock('./snapshot', () => ({
  listRepoFilePaths: vi.fn(() => []),
}));
vi.mock('../search', () => ({
  fetchUrl: vi.fn(),
  freshnessLabel: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../llm/compress', () => ({
  compressForContext: vi.fn(),
}));

import type {
  PermissionDecision,
  PermissionGateway,
} from '../plugins/permissionGateway';
import { runCodeRepoTool } from './tools';

describe('runCodeRepoTool permission integration', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'openjob-t05-'));
    writeFileSync(join(repoRoot, 'sample.ts'), 'export const answer = 42;\n', 'utf8');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('preserves authorized repository reads', async () => {
    const authorize = vi.fn(
      (): PermissionDecision => ({
        allowed: true,
        campaignId: 'campaign-engineering',
        capabilityId: 'source-repository',
        permission: 'repository:read',
      }),
    );
    const permissionGateway: PermissionGateway = { authorize };

    const outcome = await runCodeRepoTool(
      'read_file',
      { path: 'sample.ts' },
      repoRoot,
      undefined,
      {
        campaignId: 'campaign-engineering',
        repoId: 'repo-a',
        permissionGateway,
      },
    );

    expect(outcome.content).toContain('1|export const answer = 42;');
    expect(outcome.citations).toEqual([
      {
        kind: 'code',
        filePath: 'sample.ts',
        startLine: 1,
        endLine: 2,
      },
    ]);
    expect(authorize).toHaveBeenCalledWith({
      campaignId: 'campaign-engineering',
      capabilityId: 'source-repository',
      permission: 'repository:read',
      resource: { kind: 'repository', id: 'repo-a' },
    });
  });

  it('does not touch the filesystem after a structured denial', async () => {
    const permissionGateway: PermissionGateway = {
      authorize: () => ({
        allowed: false,
        code: 'permission-revoked',
        message: 'Capability permission has been revoked.',
      }),
    };

    let error: Error | null = null;
    try {
      await runCodeRepoTool(
        'read_file',
        { path: 'sample.ts' },
        repoRoot,
        undefined,
        {
          campaignId: 'campaign-other',
          repoId: 'repo-secret',
          permissionGateway,
        },
      );
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toMatchObject({
      name: 'PermissionDeniedError',
      message: 'Repository tool access denied (permission-revoked).',
    });
    expect(error?.message).not.toContain(repoRoot);
    expect(error?.message).not.toContain('repo-secret');
  });
});
