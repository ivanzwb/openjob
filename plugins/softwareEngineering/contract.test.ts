import { describe, expect, it } from 'vitest';
import { PROMPT_REGISTRY } from '@core/prompts/registry';
import { validateRolePack } from '@core/plugins/contracts';
import {
  SOFTWARE_ENGINEERING_PROMPT_REFS,
  softwareEngineeringRolePack,
} from './index';

function leafStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(leafStrings);
}

describe('softwareEngineeringRolePack contract', () => {
  it('passes the T01 RolePack validator', () => {
    expect(validateRolePack(softwareEngineeringRolePack)).toEqual([]);
  });

  it('keeps the stable runtime identity and role-pack permission boundary', () => {
    expect(softwareEngineeringRolePack.manifest).toMatchObject({
      id: 'software-engineering',
      version: '1.0.0',
      type: 'role-pack',
      compatibility: { core: '^1.0.0', schema: 23 },
      // 通用原语（工作区 + 远端拉取）与基础问答归本包页面用；repository:read 是宿主侧
      // 旧工具实现的遗留，随它下线一并删（那份实现已经不服务本包页面了）
      permissions: ['filesystem:workspace', 'llm:complete', 'network:fetch', 'repository:read'],
      dependencies: [],
    });
  });

  it('源码能力声明它用到的 LLM 角色：角色名与用途都归本包所有', () => {
    const repo = softwareEngineeringRolePack.capabilities.find(
      (declaration) => declaration.id === 'source-repository',
    );

    expect(repo?.llmRoles).toEqual([{ name: 'codeAgent', hint: expect.any(String) }]);
  });

  it('references registered prompts without embedding prompt bodies', () => {
    const documentedRefs = leafStrings(SOFTWARE_ENGINEERING_PROMPT_REFS);
    // 插入点 B 目前是迁移期：片段全部用显式 ref 引用宿主注册表
    const activeRefs = softwareEngineeringRolePack.promptFragments
      .map((fragment) => fragment.ref)
      .filter((ref): ref is string => ref !== undefined);

    expect(activeRefs.length).toBeGreaterThan(0);
    for (const ref of activeRefs) {
      expect(documentedRefs).toContain(ref);
    }

    for (const promptId of [...documentedRefs, ...activeRefs]) {
      expect(PROMPT_REGISTRY[promptId], `missing prompt registry key: ${promptId}`).toBeDefined();
      expect(promptId).toMatch(/^[a-z][A-Za-z]*(?:\.[A-Za-z][A-Za-z]*)+$/);
      expect(promptId).not.toContain('\n');
    }
  });
});
