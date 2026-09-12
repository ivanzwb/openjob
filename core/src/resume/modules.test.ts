import { describe, expect, it } from 'vitest';
import type { ResumeModuleDefinition } from '../plugins/types';
import type { ResumeParsed } from '../entities';
import {
  assembleResumeModules,
  buildResumeModulesUserSection,
  modulesNeedingExtraction,
} from './modules';

const parsed: ResumeParsed = {
  skills: ['TypeScript', 'React'],
  projects: [
    { name: 'A', summary: '', drillableTopics: ['状态管理', '性能优化'] },
    { name: 'B', summary: '', drillableTopics: [] },
  ],
  yearsOfExperience: 5,
};

function module(overrides: Partial<ResumeModuleDefinition> = {}): ResumeModuleDefinition {
  return {
    id: 'pm.business-metrics',
    label: '业务指标',
    kind: 'list',
    instruction: '抽出经历中出现过的业务指标与量级。',
    schemaVersion: 1,
    evidenceKinds: ['achievement'],
    ...overrides,
  };
}

describe('resume modules', () => {
  it('只有无法派生的模块才需要模型抽取', () => {
    const declared = [
      module({ id: 'se.tech-stack', deriveFrom: 'skills' }),
      module({ id: 'pm.business-metrics' }),
      module({ id: 'pm.product-outcomes', instruction: '' }),
    ];
    expect(modulesNeedingExtraction(declared).map((m) => m.id)).toEqual(['pm.business-metrics']);
  });

  it('没有需要抽取的模块时不追加用户消息段', () => {
    expect(
      buildResumeModulesUserSection([module({ id: 'se.tech-stack', deriveFrom: 'skills' })]),
    ).toBeNull();
  });

  it('抽取段带键名、版本与形状说明', () => {
    const section = buildResumeModulesUserSection([module()])!;
    expect(section).toContain('## 附加抽取（岗位简历模块）');
    expect(section).toContain('"pm.business-metrics"（schemaVersion 1，字符串数组）');
    expect(section).toContain('业务指标与量级');
  });

  it('派生模块从旧字段回填，模型抽到的优先', () => {
    const declared = [
      module({ id: 'se.tech-stack', deriveFrom: 'skills' }),
      module({ id: 'se.drillable', deriveFrom: 'drillableTopics', instruction: undefined }),
      module({ id: 'pm.business-metrics' }),
    ];
    const modules = assembleResumeModules(
      {
        ...parsed,
        modules: { 'pm.business-metrics': { schemaVersion: 1, data: ['续费率 18%→24%'] } },
      },
      declared,
    );

    expect(modules!['se.tech-stack']).toEqual({
      schemaVersion: 1,
      data: ['TypeScript', 'React'],
    });
    expect(modules!['se.drillable']).toEqual({
      schemaVersion: 1,
      data: ['状态管理', '性能优化'],
    });
    expect(modules!['pm.business-metrics']).toEqual({
      schemaVersion: 1,
      data: ['续费率 18%→24%'],
    });
    // 模型多给的键不保留
    expect(modules!['unknown']).toBeUndefined();
  });

  it('没有任何可组装数据时保持旧形态', () => {
    const empty: ResumeParsed = { skills: [], projects: [], yearsOfExperience: null };
    expect(assembleResumeModules(empty, [module({ id: 'x', deriveFrom: 'skills' })])).toBeUndefined();
    expect(assembleResumeModules(parsed, [])).toBeUndefined();
  });
});
