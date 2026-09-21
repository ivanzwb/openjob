/**
 * 面试语言：0.6.x 的自我介绍旁边有中文 / 英文一条选择，其余题型一律中文。
 *
 * 这里守住三件事：取值收敛到 zh / en（界面传什么都变不出第三种）、指令措辞与 0.6.x
 * 一致、以及「只有带语言选择的题型才吃这个参数」这条判定只有一份名单。
 */
import { describe, expect, it } from 'vitest';
import { softwareEngineeringRolePack, SOFTWARE_ENGINEERING_FORMAT_IDS } from '@plugins/softwareEngineering';
import {
  CORE_SELF_INTRO_FORMAT_ID,
  SELF_INTRO_EXAM_FORM_ID,
  examFormTakesLanguage,
  formatTakesInterviewLanguage,
  INTERVIEW_LANGUAGE_CHOICES,
  interviewLanguageInstruction,
  normalizeInterviewLanguage,
  practiceQuestionRequest,
  practiceScoreRequest,
  resolveBaselineFormat,
} from '@core/practice';

describe('面试语言取值', () => {
  it('只认 en，其余一律中文', () => {
    expect(normalizeInterviewLanguage('en')).toBe('en');
    expect(normalizeInterviewLanguage('zh')).toBe('zh');
    expect(normalizeInterviewLanguage('English')).toBe('zh');
    expect(normalizeInterviewLanguage(undefined)).toBe('zh');
    expect(normalizeInterviewLanguage(42)).toBe('zh');
  });

  it('界面上的两个选项就是中英文面试，默认第一个是中文', () => {
    expect(INTERVIEW_LANGUAGE_CHOICES.map((choice) => choice.value)).toEqual(['zh', 'en']);
    expect(INTERVIEW_LANGUAGE_CHOICES.map((choice) => choice.label)).toEqual([
      '中文面试',
      '英文面试',
    ]);
  });

  it('指令措辞逐字沿用 0.6.x，且点名的四件事齐全', () => {
    expect(interviewLanguageInstruction('en')).toBe(
      '请用英文模拟真实面试：题目、追问、评分反馈和改进稿都使用英文。',
    );
    expect(interviewLanguageInstruction('zh')).toBe(
      '请用中文模拟真实面试：题目、追问、评分反馈和改进稿都使用中文。',
    );
  });
});

describe('哪些题型带面试语言选择', () => {
  it('只有自我介绍：题型与面试形式两侧判定同源', () => {
    expect(examFormTakesLanguage(SELF_INTRO_EXAM_FORM_ID)).toBe(true);
    expect(formatTakesInterviewLanguage(CORE_SELF_INTRO_FORMAT_ID)).toBe(true);

    for (const form of softwareEngineeringRolePack.examForms ?? []) {
      expect(examFormTakesLanguage(form.id)).toBe(false);
    }
    expect(formatTakesInterviewLanguage(SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge)).toBe(false);
  });

  it('基线里带语言选择的题型，其面试形式也带——名单只有一份', () => {
    const { format } = resolveBaselineFormat(CORE_SELF_INTRO_FORMAT_ID)!;
    expect(examFormTakesLanguage(SELF_INTRO_EXAM_FORM_ID)).toBe(
      formatTakesInterviewLanguage(format.id),
    );
  });
});

describe('语言进 prompt', () => {
  const selfIntro = resolveBaselineFormat(CORE_SELF_INTRO_FORMAT_ID)!;

  it('出题：给语言就追加一句，没给就不追加', () => {
    const withLanguage = practiceQuestionRequest({ format: selfIntro.format, language: 'en' });
    expect(withLanguage.startsWith('请用英文模拟真实面试')).toBe(true);

    const without = practiceQuestionRequest({ format: selfIntro.format });
    expect(without).not.toContain('模拟真实面试');

    // 追问那条路径也走同一个入参
    const followUp = practiceQuestionRequest({
      format: selfIntro.format,
      followUpRound: 1,
      language: 'zh',
    });
    expect(followUp.startsWith('请用中文模拟真实面试')).toBe(true);
    expect(followUp).toContain('第 1 轮追问');
  });

  it('评分：语言排在最前，量规要求一条不少', () => {
    const text = practiceScoreRequest(selfIntro.rubric, 'en');
    expect(text.startsWith('请用英文模拟真实面试')).toBe(true);
    expect(text).toContain('answerQuote 必须是候选人回答里真实存在的一段连续文字');
    expect(text).toContain(selfIntro.rubric.dimensions[0].id);
  });
});
