/**
 * 软件工程岗位包。
 *
 * 与历史数据共用同一组 id（见 ids.ts）；包内容换代走版本号。本包自带 Prompts：
 * 四种题型的出题 / 评分 / 话术片段都在本包 prompts/ 目录里（插入点 B），出题口吻
 * 与岗位强绑定，不再引用宿主注册表。诊断与讲解仍引用宿主 PROMPT_REGISTRY 里的
 * 通用骨架（diagnosis.jd / explain.generate），由 contract test 保证 key 存在。
 */
import {
  SOFTWARE_ENGINEERING_FORMAT_IDS,
  SOFTWARE_ENGINEERING_EXAM_FORMS,
} from './examForms';
import type { PromptFragment, RolePack } from '@core/plugins/types';
import { defineRolePack, packRoot } from '../../scripts/pack-authoring';
import { SOFTWARE_ENGINEERING_ROLE_PACK_ID, SOFTWARE_ENGINEERING_ROLE_PACK_VERSION } from './ids';
import { softwareEngineeringMatchers } from './matchers';
import { competencyTemplates } from './competencies';
import { interviewFormats, interviewStages } from './formats';
import { codingRubric, technicalKnowledgeRubric } from './rubrics/technical';
import { projectDeepDiveRubric, systemDesignRubric } from './rubrics/design';
import { taskTemplates } from './tasks';
import { resumeModules } from './resume-modules';
import { capabilities } from './capabilities';
import { sourcePolicy } from './search-policy';

export {
  SOFTWARE_ENGINEERING_ROLE_PACK_ID,
  SOFTWARE_ENGINEERING_ROLE_PACK_VERSION,
  SOURCE_REPOSITORY_CAPABILITY_ID,
} from './ids';
export {
  SOFTWARE_ENGINEERING_FORMAT_IDS,
  SOFTWARE_ENGINEERING_EXAM_FORMS,
} from './examForms';

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
} as const;

const { knowledge } = SOFTWARE_ENGINEERING_FORMAT_IDS;

const promptFragments: PromptFragment[] = [
  { slot: 'diagnosis', ref: SOFTWARE_ENGINEERING_PROMPT_REFS.diagnosis.jd },
  { slot: 'explanation', ref: SOFTWARE_ENGINEERING_PROMPT_REFS.explanation.generate },
  { slot: 'questionGeneration', formatId: knowledge, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.question },
  { slot: 'scoring', formatId: knowledge, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.score },
  { slot: 'answerCoaching', formatId: knowledge, ref: SOFTWARE_ENGINEERING_PROMPT_REFS.quiz.answer },
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
    // 内嵌 source-repository 能力：权限 = 其声明的并集（contracts 校验，按字典序）。
    // 三项都是本包页面自己用的通用原语与基础问答。
    permissions: ['filesystem:workspace', 'llm:complete', 'network:fetch'],
    // 「源码」页已移入本包：页面跑在 Webview 沙箱，宿主 Repos 页退役。
    // 桌面与移动各一份实现，包内平铺在 desktop/ 与 mobile/ 下
    main: 'desktop/main.js',
    mobile: 'mobile/main.js',
    api: '^1.0',
    dependencies: [],
    // 本包自己的数据集合：宿主只按这三个名字归档与取用，不理解里面的内容。
    // 页面当前仍走 ctx.storage，改为按集合读写是后续步骤。
    dataCollections: [
      { name: 'repositories', schemaVersion: 1 },
      { name: 'code-refs', schemaVersion: 1 },
      { name: 'repository-files', schemaVersion: 1 },
    ],
  },
  roleMatchers: softwareEngineeringMatchers,
  competencyTemplates,
  interviewStages,
  interviewFormats,
  examForms: SOFTWARE_ENGINEERING_EXAM_FORMS,
  rubrics: [
    technicalKnowledgeRubric,
    codingRubric,
    systemDesignRubric,
    projectDeepDiveRubric,
  ],
  taskTemplates,
  promptFragments,
  navigation: [],
  resumeModules,
  capabilities,
  sourcePolicy,
});
