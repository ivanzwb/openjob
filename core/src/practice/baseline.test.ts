/**
 * 基线题型的用例。
 *
 * 自我介绍是基础包唯一自带的题型，也是唯一一条「不装岗位包也该能练」的链路：
 * 题型声明迁进岗位包那次它整条掉线，所以这里既盯它解析得出来，也盯它没有被
 * 岗位包悄悄接管——包若声明了同名题型，界面该按包走，基线让位而不是并列两份。
 */
import { describe, expect, it } from 'vitest';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import type { RolePack } from '../plugins/types';
import {
  BASELINE_EXAM_FORMS,
  BASELINE_INTERVIEW_FORMATS,
  BASELINE_RUBRICS,
  CORE_SELF_INTRO_FORMAT_ID,
  CORE_SELF_INTRO_RUBRIC_ID,
  SELF_INTRO_EXAM_FORM_ID,
  practiceExamForms,
  practiceFormatIdForExamForm,
  resolveBaselineFormat,
} from './baseline';
import { resolvePracticeFormat } from './rubric';

describe('基础包基线题型', () => {
  it('每个基线量规的权重和为 1，每个维度都有 1-5 的锚点', () => {
    for (const rubric of BASELINE_RUBRICS) {
      const total = rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
      expect(total, rubric.id).toBeCloseTo(1, 10);
      for (const dimension of rubric.dimensions) {
        for (const score of [1, 2, 3, 4, 5] as const) {
          expect(dimension.anchors[score], `${dimension.id}@${score}`).toBeTruthy();
        }
      }
    }
  });

  it('自我介绍的题型、面试形式、量规三段落对得上', () => {
    const form = BASELINE_EXAM_FORMS.find((item) => item.id === SELF_INTRO_EXAM_FORM_ID);
    expect(form?.formatId).toBe(CORE_SELF_INTRO_FORMAT_ID);

    const resolved = resolveBaselineFormat(CORE_SELF_INTRO_FORMAT_ID);
    expect(resolved?.format.protocol).toBe('presentation');
    expect(resolved?.rubric.id).toBe(CORE_SELF_INTRO_RUBRIC_ID);
    expect(BASELINE_INTERVIEW_FORMATS).toHaveLength(BASELINE_EXAM_FORMS.length);
  });

  it('基线维度的 id 与官方岗位包都不重叠', () => {
    // 维度 id 是跨岗位比趋势的键：重名会把量纲不同的两件事画进同一条曲线
    const packDimensions = new Set(
      DISTRIBUTED_ROLE_PACKS.flatMap((pack) =>
        pack.rubrics.flatMap((rubric) => rubric.dimensions.map((dimension) => dimension.id)),
      ),
    );
    for (const dimension of BASELINE_RUBRICS.flatMap((rubric) => rubric.dimensions)) {
      expect(packDimensions.has(dimension.id), dimension.id).toBe(false);
    }
  });

  it('岗位包没声明基线题型时按基础包兜底', () => {
    expect(softwareEngineeringRolePack.examForms?.some((form) => form.id === SELF_INTRO_EXAM_FORM_ID)).toBe(
      false,
    );
    expect(practiceFormatIdForExamForm(softwareEngineeringRolePack, SELF_INTRO_EXAM_FORM_ID)).toBe(
      CORE_SELF_INTRO_FORMAT_ID,
    );
  });

  it('岗位包声明了同名题型时以包为准，基线让位', () => {
    const pack: RolePack = {
      ...softwareEngineeringRolePack,
      examForms: [
        {
          id: SELF_INTRO_EXAM_FORM_ID,
          label: '开场介绍',
          formatId: softwareEngineeringRolePack.interviewFormats[0].id,
        },
      ],
    };

    expect(practiceFormatIdForExamForm(pack, SELF_INTRO_EXAM_FORM_ID)).toBe(
      softwareEngineeringRolePack.interviewFormats[0].id,
    );

    const forms = practiceExamForms(pack);
    expect(forms.map((form) => form.id)).toEqual([SELF_INTRO_EXAM_FORM_ID]);
    expect(forms[0].label).toBe('开场介绍');
  });

  it('下拉的来源是基线在前、岗位包在后', () => {
    const forms = practiceExamForms(softwareEngineeringRolePack);
    expect(forms[0].id).toBe(SELF_INTRO_EXAM_FORM_ID);
    expect(forms.slice(1).map((form) => form.id)).toEqual(
      softwareEngineeringRolePack.examForms?.map((form) => form.id),
    );
  });

  it('包没装时下拉只剩基线，不是空的', () => {
    expect(practiceExamForms(null).map((form) => form.id)).toEqual([SELF_INTRO_EXAM_FORM_ID]);
  });

  it('练习链路按基线形式解析，名字拼错的仍然报 unknown-format', () => {
    const resolved = resolvePracticeFormat(softwareEngineeringRolePack, CORE_SELF_INTRO_FORMAT_ID);
    expect(resolved.rubric.id).toBe(CORE_SELF_INTRO_RUBRIC_ID);

    expect(() =>
      resolvePracticeFormat(softwareEngineeringRolePack, 'core.self-introduction'),
    ).toThrowError(expect.objectContaining({ code: 'unknown-format' }));
  });
});
