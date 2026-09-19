/**
 * 题型(exam form) → interviewFormat id 的宿主侧翻译。
 *
 * 题型取值归岗位包所有（RolePack.examForms）：旧数据里存的是插件化之前的题型取值，
 * 练习页选中的也是包声明的题型 id，两者都按同一份声明查到本包的面试形式。本模块只提供
 * 按包查声明的语法糖——宿主不认识任何一个取值，包未装或未声明该题型时按空串兜底，
 * 让读历史与排程这类非出题链路继续工作。
 */
import type { RolePack } from './types';

/** 题型 id → 格式 id；包未装或未声明该题型时返回空串（调用方决定是报错还是兜底）。 */
export function formatIdForExamForm(pack: RolePack | null, examFormId: string): string {
  return pack?.examForms?.find((form) => form.id === examFormId)?.formatId ?? '';
}

/** 题型 id → 展示名；历史行标注用，包未声明该题型时返回空串（调用方兜底）。 */
export function labelForExamForm(pack: RolePack | null, examFormId: string): string {
  return pack?.examForms?.find((form) => form.id === examFormId)?.label ?? '';
}
