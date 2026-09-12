/**
 * 软件工程岗位包。
 *
 * 与历史数据共用同一组 id（见 ids.ts）；包内容换代走版本号。插入点 B 目前处于
 * 迁移期：工程流程的 Prompt 正文仍住在宿主 PROMPT_REGISTRY（它们是插件化之前
 * 写下的，角色侧重与阶段机器缠在一起），所以这里用显式 `ref` 条目引用它们，
 * 并由 contract test 保证「引用的 key 一定存在」。把正文从宿主注册表拆进本包的
 * prompts/ 目录是待办的内容工程，不是结构问题——拆出后这里换成 file 片段即可。
 *
 * 引用的完整清单（含未被插入点 B 覆盖的宿主流水线 prompt）见
 * SOFTWARE_ENGINEERING_PROMPT_REFS；被插入点 B 引用的只是其中一个子集。
 */
import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '@core/plugins/legacyRoleData';
import type { PromptFragment, RolePack } from '@core/plugins/types';
import { defineRolePack, packRoot } from '../../scripts/pack-authoring';
import { SOFTWARE_ENGINEERING_ROLE_PACK_ID, SOFTWARE_ENGINEERING_ROLE_PACK_VERSION } from './ids';
import { softwareEngineeringMatchers } from './matchers';
import { competencyTemplates } from './competencies';
import { interviewFormats, interviewStages } from './formats';
import { codingRubric, technicalKnowledgeRubric } from './rubrics/technical';
import { projectDeepDiveRubric, systemDesignRubric } from './rubrics/design';
import { taskTemplates } from './tasks';
import { navigation } from './navigation';
import { resumeModules } from './resume-modules';
import { sourcePolicy } from './search-policy';

export {
  SOFTWARE_ENGINEERING_ROLE_PACK_ID,
  SOFTWARE_ENGINEERING_ROLE_PACK_VERSION,
} from './ids';

/**
 * References into PROMPT_REGISTRY. Values are keys, never copied prompt bodies.
 * The complete map documents every prompt used by the current engineering flow;
 * promptFragments below selects the key appropriate to each role-pack slot.
 */
export const SOFTWARE_ENGINEERING_PROMPT_REFS = {
  diagnosis: {
    jd: 'diagnosis.jd',
    resume: 'diagnosis.resume',
    crossAnalyze: 'diagnosis.crossAnalyze',
    expand: 'diagnosis.expand',
    companyIntel: 'diagnosis.intel',
    extractQuestions: 'diagnosis.extractQuestions',
    matchQuestions: 'diagnosis.matchQuestions',
  },
  explanation: {
    generate: 'explain.generate',
    fallback: 'explain.fallback',
    elaborate: 'explain.elaborate',
    rewrite: 'explain.rewrite',
    followUp: 'followUp.node',
  },
  quiz: {
    question: 'quiz.question',
    score: 'quiz.score',
    answer: 'quiz.answer',
  },
  design: {
    case: 'design.case',
    score: 'design.score',
    answer: 'design.answer',
  },
} as const;

const { knowledge, coding, systemDesign, projectDeepDive } = SOFTWARE_ENGINEERING_FORMAT_IDS;

const promptFragments: PromptFragment[] = [
  { slot: 'diagnosis', ref: SOFTWARE_ENGINEERING_PROMPT_REFS.diagnosis.jd },
  { slot: 'explanation', ref: SOFTWARE_ENGINEERING_PROMPT_REFS.explanation.generate },
  { slot: 'questionGeneration', formatId: knowledge, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.question },
  { slot: 'questionGeneration', formatId: coding, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.case },
  { slot: 'questionGeneration', formatId: systemDesign, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.case },
  { slot: 'questionGeneration', formatId: projectDeepDive, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.case },
  { slot: 'scoring', formatId: knowledge, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.score },
  { slot: 'scoring', formatId: coding, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.score },
  { slot: 'scoring', formatId: systemDesign, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.score },
  { slot: 'scoring', formatId: projectDeepDive, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.score },
  { slot: 'answerCoaching', formatId: knowledge, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.answer },
  { slot: 'answerCoaching', formatId: coding, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.answer },
  { slot: 'answerCoaching', formatId: systemDesign, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.answer },
  { slot: 'answerCoaching', formatId: projectDeepDive, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.design.answer },
];

export const softwareEngineeringRolePack: RolePack = defineRolePack({
  root: packRoot(import.meta.url),
  manifest: {
    id: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
    version: SOFTWARE_ENGINEERING_ROLE_PACK_VERSION,
    type: 'role-pack',
    displayName: '软件工程',
    description: '软件工程岗位的技术诊断、训练和模拟面试声明',
    compatibility: { core: '^1.0.0', schema: 23 },
    permissions: [],
    dependencies: [{ id: CORE_CAPABILITIES_PACK_ID, version: '^1.0.0', optional: true }],
  },
  roleMatchers: softwareEngineeringMatchers,
  competencyTemplates,
  interviewStages,
  interviewFormats,
  rubrics: [
    technicalKnowledgeRubric,
    codingRubric,
    systemDesignRubric,
    projectDeepDiveRubric,
  ],
  taskTemplates,
  promptFragments,
  navigation,
  resumeModules,
  sourcePolicy,
});
