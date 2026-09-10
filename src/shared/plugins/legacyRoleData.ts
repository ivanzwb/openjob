/**
 * 插件化之前就写进库里的岗位事实。
 *
 * 这些字面量原来长在软件工程岗位包里，岗位包移出基础包之后必须留在宿主：读一条插件化
 * 之前的 `knowledge_node.exam_forms` 或 `quiz_attempt` 不该要求本机装着某个岗位包。
 * 它们描述的是**历史数据当时的形状**，不是当前岗位包的内容——软件工程包后续改版、甚至
 * 换个人维护，这里也不能跟着改，否则旧记录会被投影成另一套题型和量规。
 *
 * 岗位包反过来引用这里，保证「当前包」与「历史数据」这两处的 id 只有一份。
 */
import type { ExamForm } from '../enums';

/** 旧数据固定的岗位包引用，回填与兜底描述符共用，改一个字就会让旧战役的 hash 跳变。 */
export const LEGACY_ROLE_PACK_REF = {
  id: 'software-engineering',
  version: '1.0.0',
} as const;

export const SOFTWARE_ENGINEERING_FORMAT_IDS = {
  knowledge: 'se.technical-knowledge',
  coding: 'se.coding',
  systemDesign: 'se.system-design',
  projectDeepDive: 'se.project-technical-deep-dive',
} as const;

/**
 * Compatibility bridge for persisted KnowledgeNode.examForms.
 * Keep this exhaustive: legacy values remain readable for at least one release cycle.
 */
export const LEGACY_EXAM_FORM_TO_FORMAT_ID = {
  concept: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
  coding: SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
  design: SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
  scenario: SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
} as const satisfies Record<ExamForm, string>;

export function formatIdForLegacyExamForm(examForm: ExamForm): string {
  return LEGACY_EXAM_FORM_TO_FORMAT_ID[examForm];
}

/**
 * 旧记录投影用的量规 id。
 *
 * quiz_attempt / design_case 都是插件化之前的软件工程数据，投影时要标出「当时按哪套量规
 * 评的」。原来是现查软件工程包的 interviewFormats 拿 rubricId，包移出基础包之后查不到就
 * 只能填空字符串——那等于把历史记录的量规锚点悄悄丢了。这份表是那次查询的结果快照。
 */
export const LEGACY_FORMAT_TO_RUBRIC_ID: Readonly<Record<string, string>> = {
  [SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge]: 'se.technical-knowledge-rubric',
  [SOFTWARE_ENGINEERING_FORMAT_IDS.coding]: 'se.coding-rubric',
  [SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign]: 'se.system-design-rubric',
  [SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive]: 'se.project-technical-deep-dive-rubric',
};
