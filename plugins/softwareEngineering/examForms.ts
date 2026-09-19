import type { ExamFormDefinition } from '@core/plugins/types';

/**
 * 软件工程岗位包与旧数据共用的格式 id。
 *
 * 插件化之前 knowledge_node.exam_forms / design_case.interview_type 直接存旧题型
 * 取值；本包的题型声明按同一 id 声明（见 SOFTWARE_ENGINEERING_EXAM_FORMS），
 * 装入本包即在宿主侧恢复对旧数据的完整投影。id 必须与历史 pin 一致——改一个字
 * 就会让旧战役的题型投影换一套量规。
 */
export const SOFTWARE_ENGINEERING_FORMAT_IDS = {
  knowledge: 'se.technical-knowledge',
  coding: 'se.coding',
  systemDesign: 'se.system-design',
  projectDeepDive: 'se.project-technical-deep-dive',
} as const;

/**
 * 本包声明的题型。
 *
 * id 沿用插件化之前的旧取值：knowledge_node.exam_forms 与旧模拟面试题表的
 * interview_type 里存的就是这些值，宿主按同一 id 去声明里查本包的面试形式，历史
 * 投影因此复原。具体取值归本包所有，基础包不再枚举它们。
 */
export const SOFTWARE_ENGINEERING_EXAM_FORMS: ExamFormDefinition[] = [
  {
    id: 'concept',
    label: '概念 / 八股',
    formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.knowledge,
    diagnosisHint: '概念、原理、八股式追问',
  },
  {
    id: 'coding',
    label: '编码 / 算法',
    formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
    diagnosisHint: '编码、算法、数据结构',
  },
  {
    id: 'design',
    label: '系统设计',
    formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
    diagnosisHint: '系统设计、架构与关键取舍',
  },
  {
    id: 'scenario',
    label: '项目 / 场景',
    formatId: SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    diagnosisHint: '项目深挖、行为场景',
  },
];
