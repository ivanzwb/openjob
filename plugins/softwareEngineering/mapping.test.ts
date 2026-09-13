import { describe, expect, it } from 'vitest';
import { EXAM_FORMS, TASK_KINDS } from '@core/enums';
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
import {
  SOFTWARE_ENGINEERING_EXAM_FORM_MAPPINGS,
  SOFTWARE_ENGINEERING_FORMAT_IDS,
  formatIdForExamForm,
} from './examForms';
import { softwareEngineeringRolePack } from './index';

describe('software engineering exam-form mappings', () => {
  it('declares every ExamForm on the role pack and maps to a stable interview format', () => {
    expect(softwareEngineeringRolePack.examFormMappings).toEqual({
      concept: 'se.technical-knowledge',
      coding: 'se.coding',
      design: 'se.system-design',
      scenario: 'se.project-technical-deep-dive',
    });
    expect(Object.keys(SOFTWARE_ENGINEERING_EXAM_FORM_MAPPINGS).sort()).toEqual(
      [...EXAM_FORMS].sort(),
    );

    const registeredIds = new Set(
      softwareEngineeringRolePack.interviewFormats.map((format) => format.id),
    );
    const mappedIds = EXAM_FORMS.map(formatIdForExamForm);
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
      capabilityId: CORE_CAPABILITIES_PACK_ID,
    });
    expect(
      softwareEngineeringRolePack.taskTemplates
        .filter((task) => task.taskKind !== 'readCode')
        .every((task) => task.capabilityId === undefined),
    ).toBe(true);
  });
});