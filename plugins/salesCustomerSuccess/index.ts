/**
 * 销售 / 客户成功岗位包。
 *
 * 与产品经理包一样自带全部 Prompt 片段（prompts/ 目录），不引用 Core 的工程
 * prompt。这个岗位还多压着一件事：它是第一个真正需要「实时对话」的岗位——客户
 * 对话和商务谈判的质量体现在听懂了没有、追问对不对、被顶回来之后怎么走，这些在
 * 一问一答的文本里只能看到影子。角色扮演能力（role-play）因此是可选依赖。
 *
 * 降级的落点在 interviewStages 上，而不是在 Core 里加判断：需要对话的那两轮
 * 同时列出 role-play 与文本行为题两个题型 ID，宿主按可用性取第一个。这样没装
 * 插件的用户拿到的是一份完整的、全部由文本行为题构成的面试蓝图，而不是两轮空白。
 * 由此得到一条可以被测试守住的性质：每条能力、每一轮都至少有一个不依赖任何
 * 能力插件的题型。
 *
 * 评分维度刻意不含技术准确性、吞吐、容量这类工程口径——销售岗位的高分与低分
 * 差在能不能问出真实痛点、能不能把价值说到对方的衡量标准上，与实现细节无关。
 */
import type { RolePack } from '@core/plugins/types';
import { defineRolePack, packRoot } from '../../scripts/pack-authoring';
import {
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
  SALES_ROLE_PLAY_CAPABILITY_ID,
} from './ids';
import { salesCustomerSuccessMatchers } from './matchers';
import { competencyTemplates } from './competencies';
import { interviewFormats, interviewStages } from './formats';
import { behavioralRubric, rolePlayRubric } from './rubrics';
import { taskTemplates } from './tasks';
import { resumeModules } from './resume-modules';
import { sourcePolicy } from './search-policy';

export {
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
  SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
  SALES_ROLE_PLAY_CAPABILITY_ID,
  SALES_CUSTOMER_SUCCESS_FORMAT_IDS,
  SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS,
  SALES_CUSTOMER_SUCCESS_RUBRIC_IDS,
} from './ids';

export const salesCustomerSuccessRolePack: RolePack = defineRolePack({
  root: packRoot(import.meta.url),
  manifest: {
    id: SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID,
    version: SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION,
    type: 'role-pack',
    displayName: '销售 / 客户成功',
    description: '销售与客户成功岗位的能力诊断、对话训练和模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [],
    dependencies: [
      { id: SALES_ROLE_PLAY_CAPABILITY_ID, version: '^1.0.0', optional: true },
    ],
  },
  roleMatchers: salesCustomerSuccessMatchers,
  competencyTemplates,
  interviewStages,
  interviewFormats,
  rubrics: [rolePlayRubric, behavioralRubric],
  taskTemplates,
  // 插入点 A：销售岗位暂无能力页签，声明为空数组
  navigation: [],
  resumeModules,
  sourcePolicy,
});
