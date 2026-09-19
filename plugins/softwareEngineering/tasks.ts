import type { TaskTemplate } from '@core/plugins/types';
import { EXAM_FORMS } from '@core/enums';
import { SOFTWARE_ENGINEERING_FORMAT_IDS, formatIdForExamForm } from './examForms';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from './ids';

const allFormatIds = EXAM_FORMS.map(formatIdForExamForm);

/**
 * 任务种类由本包声明：宿主只认识自己生成的 learn / drill / review / fallbackScript，
 * 工程岗的 read-code 是本包自己的种类，任务页也由本包提供（见 `view`）。
 */
export const taskTemplates: TaskTemplate[] = [
  {
    id: 'se.learn',
    label: '学习工程考点',
    taskKind: 'learn',
    defaultMinutes: 30,
    supportedFormats: allFormatIds,
  },
  {
    id: 'se.drill',
    label: '口头技术演练',
    taskKind: 'drill',
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'se.read-code',
    label: '结合源码理解实现',
    taskKind: 'readCode',
    defaultMinutes: 25,
    supportedFormats: [
      SOFTWARE_ENGINEERING_FORMAT_IDS.coding,
      SOFTWARE_ENGINEERING_FORMAT_IDS.systemDesign,
      SOFTWARE_ENGINEERING_FORMAT_IDS.projectDeepDive,
    ],
    capabilityId: SOURCE_REPOSITORY_CAPABILITY_ID,
    // 任务需要一份已检出到本包工作区的代码材料；具体是哪份由排程挑（宿主按可用性选）
    materialKind: 'code-repository',
    // 材料行放在本包声明的 repositories 集合里（见 manifest.dataCollections）：
    // 宿主不认识材料语义，只按 (kind, collection) 取数
    materialCollection: 'repositories',
    // 任务页就是本包的「源码」页：宿主只把它挂进任务栏，页面内容由本包提供
    view: { pageId: 'source-repository' },
  },
  {
    id: 'se.review',
    label: '复习薄弱考点',
    taskKind: 'review',
    defaultMinutes: 15,
    supportedFormats: allFormatIds,
  },
  {
    id: 'se.fallback-script',
    label: '准备技术兜底话术',
    taskKind: 'fallbackScript',
    defaultMinutes: 10,
    supportedFormats: allFormatIds,
  },
];
