import type { ResumeModuleDefinition } from '@core/plugins/types';

/**
 * 插入点 D：产品岗位的简历模块。
 *
 * 指令用正面表述描述「抽什么」：把不要的东西写进指令等于先让模型想一遍。
 * 这两个模块没有旧字段可派生，解析时作为附加抽取进入 diagnosis.resume 的用户消息。
 */
export const resumeModules: ResumeModuleDefinition[] = [
  {
    id: 'pm.business-metrics',
    label: '业务指标',
    kind: 'list',
    schemaVersion: 1,
    evidenceKinds: ['achievement', 'experience'],
    instruction:
      '从工作与项目经历中抽出候选人提到过的业务指标，保留当时的量级与口径（如「续费率从 18% 提升到 24%」）。',
  },
  {
    id: 'pm.product-outcomes',
    label: '产品成果',
    kind: 'list',
    schemaVersion: 1,
    evidenceKinds: ['achievement', 'experience'],
    instruction:
      '抽出有结果支撑的产品成果：做了什么决定或改动、带来什么可追溯的变化；只有职责描述、说不出结果的不要收。',
  },
];
