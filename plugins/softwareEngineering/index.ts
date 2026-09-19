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
    // 四项都是本包页面自己用的通用原语与基础问答；library:write 让页面能把一段代码
    // 存进用户的话术库（来源类型由本包自己起，宿主不认识）。
    permissions: ['filesystem:workspace', 'library:write', 'llm:complete', 'network:fetch'],
    // 「源码」页已移入本包：页面跑在 Webview 沙箱，宿主 Repos 页退役。
    // 桌面与移动各一份实现，包内平铺在 desktop/ 与 mobile/ 下
    main: 'desktop/main.js',
    mobile: 'mobile/main.js',
    api: '^1.0',
    dependencies: [],
    // 标记目标路由（插入点 F）：本包页面把代码位置标记写进宿主标记汇总时用的 targetKind 是
    // code-mark（宿主不认识），这里声明它由本包的「源码」页承接。宿主据此把汇总里的这类行
    // 变成可跳转：切到 source-repository 页并经 annotation:open 事件把 { kind, targetId } 交过去。
    annotationTargets: [{ kind: 'code-mark', label: '代码位置', pageId: 'source-repository' }],
    // 本包自己的数据集合：宿主只按这些名字归档与取用，不理解里面的内容。
    // - repositories：检出登记表（排程按 (kind, collection) 取代码材料）；
    // - qa-history：按检出分片的问答历史（问题 / 回答 / 引用 / 时间），跨端同步共用；
    // - repository-indexes：按检出存的索引产物（摘要 / 仓库地图 / 状态 / 建立时间）。
    // code-refs 与 repository-files 是旧通道留下的登记名，保留以兼容既有声明形状。
    // 代码位置标记不再放在本包自己的集合里：它改走宿主的标记原语（library.annotate），
    // 写进宿主跨功能的标记汇总，因而也会出现在宿主的标记面板里——所以 code-marks 退掉。
    dataCollections: [
      { name: 'repositories', schemaVersion: 1 },
      { name: 'code-refs', schemaVersion: 1 },
      { name: 'repository-files', schemaVersion: 1 },
      { name: 'qa-history', schemaVersion: 1 },
      { name: 'repository-indexes', schemaVersion: 1 },
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
