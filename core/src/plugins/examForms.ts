/**
 * 题型(ExamForm) ↔ interviewFormat id 的宿主侧翻译。
 *
 * 插件化之前 knowledge_node.exam_forms / design_case.interview_type 直接存旧题型取值
 * （concept/coding/design/scenario）；插件化后这些取值要翻译成岗位包的格式 id，
 * 而翻译内容归岗位包所有（RolePack.examFormMappings）。本模块只提供按包取值的
 * 语法糖：包未装或未声明时按空串/design 兜底，让读历史与排程这类非出题链路继续工作。
 */
import type { ExamForm } from '../enums';
import type { RolePack } from './types';

/** ExamForm → 格式 id；包未装或未声明该题型时返回空串（调用方决定是报错还是兜底）。 */
export function formatIdForExamForm(pack: RolePack | null, examForm: ExamForm): string {
  return pack?.examFormMappings?.[examForm] ?? '';
}

/** 格式 id → ExamForm（出题对话的题型判断）；岗位包扩展的格式没有旧取值时退回 design。 */
export function examFormForFormatId(pack: RolePack | null, formatId: string): ExamForm {
  const mappings = pack?.examFormMappings;
  if (mappings) {
    for (const [examForm, id] of Object.entries(mappings)) {
      if (id === formatId) return examForm as ExamForm;
    }
  }
  return 'design';
}