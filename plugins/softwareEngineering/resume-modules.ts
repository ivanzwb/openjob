import type { ResumeModuleDefinition } from '@core/plugins/types';

/**
 * 插入点 D：工程岗位的简历模块。
 *
 * 两个模块都能从 ResumeParsed 的旧字段派生（skills / projects.drillableTopics），
 * 不参与模型抽取——工程岗位的解析行为因此一个字不变，老简历也不用重新解析。
 */
export const resumeModules: ResumeModuleDefinition[] = [
  {
    id: 'se.tech-stack',
    label: '技术栈',
    kind: 'list',
    schemaVersion: 1,
    evidenceKinds: ['skill'],
    deriveFrom: 'skills',
  },
  {
    id: 'se.drillable-tech-topics',
    label: '可深挖技术点',
    kind: 'list',
    schemaVersion: 1,
    evidenceKinds: ['experience', 'skill'],
    deriveFrom: 'drillableTopics',
  },
];
