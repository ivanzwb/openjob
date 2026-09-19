import { describe, expect, it } from 'vitest';
import { TASK_KINDS } from '@core/enums';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from './ids';
import { SOFTWARE_ENGINEERING_EXAM_FORMS, SOFTWARE_ENGINEERING_FORMAT_IDS } from './examForms';
import { softwareEngineeringRolePack } from './index';

describe('software engineering exam-form mappings', () => {
  it('declares every exam form on the role pack and maps to a stable interview format', () => {
    expect(
      Object.fromEntries(SOFTWARE_ENGINEERING_EXAM_FORMS.map((form) => [form.id, form.formatId])),
    ).toEqual({
      concept: 'se.technical-knowledge',
      coding: 'se.coding',
      design: 'se.system-design',
      scenario: 'se.project-technical-deep-dive',
    });
    // 题型声明随包分发，包的 examForms 就是这份声明
    expect(softwareEngineeringRolePack.examForms).toEqual(SOFTWARE_ENGINEERING_EXAM_FORMS);

    const registeredIds = new Set(
      softwareEngineeringRolePack.interviewFormats.map((format) => format.id),
    );
    const mappedIds = SOFTWARE_ENGINEERING_EXAM_FORMS.map((form) => form.formatId);
    expect(new Set(mappedIds).size).toBe(SOFTWARE_ENGINEERING_EXAM_FORMS.length);
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
    const kinds = softwareEngineeringRolePack.taskTemplates.map((task) => task.taskKind);
    // 宿主自己生成的四种任务都要有适配；readCode 是本包自己的种类（宿主不认识它）
    for (const kind of TASK_KINDS) {
      expect(kinds, kind).toContain(kind);
    }
    expect(kinds).toContain('readCode');

    const readCode = softwareEngineeringRolePack.taskTemplates.find(
      (task) => task.taskKind === 'readCode',
    );
    expect(readCode).toMatchObject({
      id: 'se.read-code',
      defaultMinutes: 25,
      capabilityId: SOURCE_REPOSITORY_CAPABILITY_ID,
      // 需要一份代码材料，且任务页由本包提供
      materialKind: 'code-repository',
      view: { pageId: 'source-repository' },
    });
    expect(
      softwareEngineeringRolePack.taskTemplates
        .filter((task) => task.taskKind !== 'readCode')
        .every((task) => task.capabilityId === undefined),
    ).toBe(true);
  });
});
