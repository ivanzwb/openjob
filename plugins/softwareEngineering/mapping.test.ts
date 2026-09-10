import { describe, expect, it } from 'vitest';
import { EXAM_FORMS, TASK_KINDS } from '@shared/enums';
import { LEGACY_EXAM_FORM_TO_FORMAT_ID, SOFTWARE_ENGINEERING_FORMAT_IDS, formatIdForLegacyExamForm } from '@shared/plugins/legacyRoleData';
import { softwareEngineeringRolePack } from './index';

describe('software engineering legacy mappings', () => {
  it('maps every legacy ExamForm to one stable interview format', () => {
    expect(LEGACY_EXAM_FORM_TO_FORMAT_ID).toEqual({
      concept: 'se.technical-knowledge',
      coding: 'se.coding',
      design: 'se.system-design',
      scenario: 'se.project-technical-deep-dive',
    });
    expect(Object.keys(LEGACY_EXAM_FORM_TO_FORMAT_ID).sort()).toEqual([...EXAM_FORMS].sort());

    const registeredIds = new Set(
      softwareEngineeringRolePack.interviewFormats.map((format) => format.id),
    );
    const mappedIds = EXAM_FORMS.map(formatIdForLegacyExamForm);
    expect(new Set(mappedIds).size).toBe(EXAM_FORMS.length);
    for (const formatId of mappedIds) expect(registeredIds.has(formatId)).toBe(true);
  });

  it('preserves the interaction protocol of each engineering exam form', () => {
    const protocols = Object.fromEntries(
      softwareEngineeringRolePack.interviewFormats.map((format) => [
        format.id,
        format.protocol,
      ]),
    );

    expect(protocols).toEqual({
      [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge]: 'knowledge',
      [SOFTWARE_ENGINEERING_FORMAT_IDS.coding]: 'coding',
      [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign]: 'case',
      [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive]: 'behavioral',
    });
  });

  it('adapts all existing task kinds and scopes repository work explicitly', () => {
    expect(softwareEngineeringRolePack.taskTemplates.map((task) => task.taskKind)).toEqual(
      TASK_KINDS,
    );

    const readCode = softwareEngineeringRolePack.taskTemplates.find(
      (task) => task.taskKind === 'readCode',
    );
    expect(readCode).toMatchObject({
      id: 'se.read-code',
      defaultMinutes: 25,
      capabilityId: 'source-repository',
    });
    expect(
      softwareEngineeringRolePack.taskTemplates
        .filter((task) => task.taskKind !== 'readCode')
        .every((task) => task.capabilityId === undefined),
    ).toBe(true);
  });
});
