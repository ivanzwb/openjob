import { describe, expect, it } from 'vitest';
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
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

  it('keeps the legacy runtime identity and role-pack permission boundary', () => {
    expect(softwareEngineeringRolePack.manifest).toMatchObject({
      id: 'software-engineering',
      version: '1.1.0',
      type: 'role-pack',
      compatibility: { core: '^1.0.0', schema: 23 },
      permissions: [],
      dependencies: [{ id: CORE_CAPABILITIES_PACK_ID, version: '^1.0.0', optional: true }],
    });
  });

  it('references registered prompts without embedding prompt bodies', () => {
    const documentedRefs = leafStrings(SOFTWARE_ENGINEERING_PROMPT_REFS);
    const activeRefs = leafStrings(softwareEngineeringRolePack.promptFragments);

    expect(new Set(documentedRefs)).toEqual(
      new Set([
        'diagnosis.jd',
        'diagnosis.resume',
        'diagnosis.crossAnalyze',
        'diagnosis.expand',
        'diagnosis.intel',
        'diagnosis.extractQuestions',
        'diagnosis.matchQuestions',
        'explain.generate',
        'explain.fallback',
        'explain.elaborate',
        'explain.rewrite',
        'followUp.node',
        'quiz.question',
        'quiz.score',
        'quiz.answer',
        'design.case',
        'design.score',
        'design.answer',
      ]),
    );

    for (const promptId of [...documentedRefs, ...activeRefs]) {
      expect(PROMPT_REGISTRY[promptId], `missing prompt registry key: ${promptId}`).toBeDefined();
      expect(promptId).toMatch(/^[a-z][A-Za-z]*(?:\.[A-Za-z][A-Za-z]*)+$/);
      expect(promptId).not.toContain('\n');
    }
  });
});
