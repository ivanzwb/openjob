import type { ExamForm } from '@core/enums';

/**
 * 软件工程岗位包与旧数据共用的格式 id。
 *
 * 这份声明是「旧题型取值（ExamForm）→ 本包 interviewFormat id」翻译的来源：
 * 插件化之前 knowledge_node.exam_forms / design_case.interview_type 直接存旧题型
 * 取值，装入本包即在宿主侧恢复对旧数据的完整投影。id 必须与历史 pin 一致——
 * 改一个字就会让旧战役的题型投影换一套量规。
 */
export const SOFTWARE_ENGINEERING_FORMAT_IDS = {
  knowledge: 'se.technical-knowledge',
  coding: 'se.coding',
  systemDesign: 'se.system-design',
  projectDeepDive: 'se.project-technical-deep-dive',
} as const;

/** 旧题型 → 本包格式 id 的完整映射；必须覆盖所有 EXAM_FORMS（mapping.test 守着）。 */
export const SOFTWARE_ENGINEERING_EXAM_FORM_MAPPINGS = {
  concept: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
  coding: SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
  design: SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
  scenario: SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
} as const satisfies Record<ExamForm, string>;

/** 一元翻译：旧题型 → 本包格式 id（组合使用，如 EXAM_FORMS.map(formatIdForExamForm)）。 */
export function formatIdForExamForm(examForm: ExamForm): string {
  return SOFTWARE_ENGINEERING_EXAM_FORM_MAPPINGS[examForm];
}