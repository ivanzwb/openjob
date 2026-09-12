/**
 * 首个非工程岗位包。
 *
 * 它同时是插件化的验收样本：产品岗位与工程岗位共用 Core 的组合器、练习引擎和
 * 排程器，差异必须全部落在这份声明里。所以这里刻意不复用 Core 现有的工程
 * Prompt——`diagnosis.jd` 把 examForms 写死成 concept/coding/design/scenario，
 * `design.case` 与 `quiz.*` 也都按工程题型描述任务，产品岗位引用它们等于把编码和
 * 容量估算的口吻带进产品案例。岗位包在 prompts/ 下自带片段文件（插入点 B）：
 * 片段只能追加，一级标题、事实来源规则和输出骨架仍归 Core。
 *
 * 案例题一律用纯文字描述数据，不依赖 `analytics-case`：该能力只是可选依赖，
 * 没装时解析结果里它是 disabled，产品案例仍然要能完整出题、作答和评分。
 */
import { defineRolePack, packRoot } from '../../scripts/pack-authoring';
import type { RolePack } from '@core/plugins/types';
import { PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS, PRODUCT_MANAGER_ROLE_PACK_ID, PRODUCT_MANAGER_ROLE_PACK_VERSION } from './ids';
import { productManagerMatchers } from './matchers';
import { competencyTemplates } from './competencies';
import { interviewFormats, interviewStages } from './formats';
import { behavioralRubric, presentationRubric, productCaseRubric } from './rubrics';
import { taskTemplates } from './tasks';
import { resumeModules } from './resume-modules';
import { capabilities } from './capabilities';
import { sourcePolicy } from './search-policy';

export {
  PRODUCT_MANAGER_ROLE_PACK_ID,
  PRODUCT_MANAGER_ROLE_PACK_VERSION,
  PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS,
  PRODUCT_MANAGER_FORMAT_IDS,
  PRODUCT_MANAGER_COMPETENCY_IDS,
  PRODUCT_MANAGER_RUBRIC_IDS,
} from './ids';

export const productManagerRolePack: RolePack = defineRolePack({
  root: packRoot(import.meta.url),
  manifest: {
    id: PRODUCT_MANAGER_ROLE_PACK_ID,
    version: PRODUCT_MANAGER_ROLE_PACK_VERSION,
    type: 'role-pack',
    displayName: '产品经理',
    description: '产品经理岗位的能力诊断、案例训练和模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    // 内嵌 analytics-case：权限 = 其声明的并集（contracts 校验）
    permissions: ['artifact:read'],
    // portfolio-review 尚无宿主实现，保留为可选依赖；analytics-case 已内嵌
    dependencies: [
      {
        id: PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS.portfolioReview,
        version: '^1.0.0',
        optional: true,
      },
    ],
  },
  roleMatchers: productManagerMatchers,
  competencyTemplates,
  interviewStages,
  interviewFormats,
  rubrics: [productCaseRubric, behavioralRubric, presentationRubric],
  taskTemplates,
  // 插入点 A：产品岗位暂无能力页签，声明为空数组
  navigation: [],
  resumeModules,
  capabilities,
  sourcePolicy,
});
