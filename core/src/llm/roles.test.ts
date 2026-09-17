import { describe, expect, it } from 'vitest';
import { BASE_LLM_ROLES } from '../enums';
import { BASE_LLM_ROLE_HINTS, collectLlmRoles, isValidLlmRoleName } from './roles';

describe('collectLlmRoles', () => {
  it('没有包声明时只有基础角色，顺序按 BASE_LLM_ROLES', () => {
    const roles = collectLlmRoles();
    expect(roles.map((role) => role.name)).toEqual([...BASE_LLM_ROLES]);
    expect(roles.every((role) => role.sourcePluginId === null)).toBe(true);
    expect(roles.every((role) => role.hint === BASE_LLM_ROLE_HINTS[role.name as never])).toBe(true);
  });

  it('包声明的角色排在基础角色后面，带用途说明与来源', () => {
    const roles = collectLlmRoles([
      { role: { name: 'codeAgent', hint: '源码检索与理解' }, pluginId: 'software-engineering' },
    ]);

    expect(roles.map((role) => role.name)).toEqual([...BASE_LLM_ROLES, 'codeAgent']);
    expect(roles.at(-1)).toEqual({
      name: 'codeAgent',
      hint: '源码检索与理解',
      sourcePluginId: 'software-engineering',
    });
  });

  it('声明没给说明时 hint 为 null，而不是编一段出来', () => {
    const roles = collectLlmRoles([{ role: { name: 'someRole' }, pluginId: 'demo' }]);
    expect(roles.at(-1)?.hint).toBeNull();
  });

  it('同名以基础角色为准，包声明顶不掉基础角色的归属', () => {
    const roles = collectLlmRoles([
      { role: { name: 'quiz', hint: '被冒名顶替的说明' }, pluginId: 'rogue' },
    ]);

    const quiz = roles.filter((role) => role.name === 'quiz');
    expect(quiz).toHaveLength(1);
    expect(quiz[0]).toEqual({
      name: 'quiz',
      hint: BASE_LLM_ROLE_HINTS.quiz,
      sourcePluginId: null,
    });
  });

  it('多个包声明的角色按名字排序，不随安装顺序抖动', () => {
    const forward = collectLlmRoles([
      { role: { name: 'zRole' }, pluginId: 'a' },
      { role: { name: 'aRole' }, pluginId: 'b' },
    ]);
    const backward = collectLlmRoles([
      { role: { name: 'aRole' }, pluginId: 'b' },
      { role: { name: 'zRole' }, pluginId: 'a' },
    ]);

    expect(forward.map((role) => role.name)).toEqual(backward.map((role) => role.name));
    expect(forward.map((role) => role.name).slice(-2)).toEqual(['aRole', 'zRole']);
  });
});

describe('isValidLlmRoleName', () => {
  it('只接受字母开头的标识符', () => {
    for (const name of ['codeAgent', 'outline', 'a', 'role2']) {
      expect(isValidLlmRoleName(name), name).toBe(true);
    }
    for (const name of ['', '2role', 'code-agent', 'code agent', '../x', undefined, 1]) {
      expect(isValidLlmRoleName(name), String(name)).toBe(false);
    }
  });
});
