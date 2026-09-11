import { describe, expect, it } from 'vitest';
import { softwareEngineeringRolePack } from './index';

interface RoleGolden {
  title: string;
  jd: string;
  matches: boolean;
}

const ROLE_GOLDENS: RoleGolden[] = [
  {
    title: 'Senior Backend Engineer',
    jd: 'Design distributed systems, review code, and improve service reliability.',
    matches: true,
  },
  {
    title: '前端开发工程师',
    jd: '负责 TypeScript 应用架构、性能优化、自动化测试和持续交付。',
    matches: true,
  },
  {
    title: 'iOS Engineer',
    jd: 'Build reliable mobile features and maintain the client architecture.',
    matches: true,
  },
  {
    title: 'Product Manager',
    jd: 'Own product roadmap, user research, metrics, and prioritization.',
    matches: false,
  },
  {
    title: '客户成功经理',
    jd: '负责客户续约、异议处理和价值沟通。',
    matches: false,
  },
  {
    title: 'Data Analyst',
    jd: 'Build dashboards, define business metrics, and communicate insights.',
    matches: false,
  },
];

function matchesSoftwareEngineeringRole(title: string, jd: string): boolean {
  return softwareEngineeringRolePack.roleMatchers.some((matcher) => {
    const titleMatches = matcher.titlePatterns.some((pattern) => new RegExp(pattern, 'i').test(title));
    const excluded = (matcher.excludeSignals ?? []).some((signal) =>
      jd.toLocaleLowerCase().includes(signal.toLocaleLowerCase()),
    );
    return titleMatches && !excluded;
  });
}

describe('software engineering role pack goldens', () => {
  it.each(ROLE_GOLDENS)('classifies $title without cross-role contamination', (golden) => {
    expect(matchesSoftwareEngineeringRole(golden.title, golden.jd)).toBe(golden.matches);
  });

  it('keeps the stable engineering competency and rubric baseline', () => {
    expect(softwareEngineeringRolePack.competencyTemplates.map(({ id }) => id)).toEqual([
      'se.computer-science-foundations',
      'se.coding-and-algorithms',
      'se.system-design',
      'se.software-delivery',
      'se.technical-project-depth',
    ]);
    expect(
      softwareEngineeringRolePack.rubrics.map((rubric) => ({
        id: rubric.id,
        dimensions: rubric.dimensions.map((dimension) => dimension.id),
      })),
    ).toEqual([
      {
        id: 'se.technical-knowledge-rubric',
        dimensions: ['technical-accuracy', 'depth', 'tradeoffs'],
      },
      {
        id: 'se.coding-rubric',
        dimensions: [
          'correctness',
          'complexity',
          'edge-cases-and-testing',
          'implementation-clarity',
        ],
      },
      {
        id: 'se.system-design-rubric',
        dimensions: [
          'requirements-and-scale',
          'architecture-and-data-flow',
          'scalability-and-reliability',
          'design-tradeoffs',
        ],
      },
      {
        id: 'se.project-technical-deep-dive-rubric',
        dimensions: [
          'technical-ownership',
          'evidence-and-results',
          'decision-reasoning',
          'technical-reflection',
        ],
      },
    ]);
  });

  it('keeps the Core generic interview baseline out of this role pack', () => {
    const roleOwnedText = JSON.stringify({
      competencies: softwareEngineeringRolePack.competencyTemplates,
      stages: softwareEngineeringRolePack.interviewStages,
      formats: softwareEngineeringRolePack.interviewFormats,
      tasks: softwareEngineeringRolePack.taskTemplates,
    }).toLocaleLowerCase();

    for (const coreBaselineMarker of [
      'selfintro',
      'self-introduction',
      '自我介绍',
      '求职动机',
      '优势与短板',
      '冲突',
      '失败',
      '反问面试官',
    ]) {
      expect(roleOwnedText, `Core baseline leaked: ${coreBaselineMarker}`).not.toContain(
        coreBaselineMarker.toLocaleLowerCase(),
      );
    }
  });

  it('retains the existing engineering search credibility and freshness policy', () => {
    expect(softwareEngineeringRolePack.sourcePolicy).toEqual({
      preferredDomains: [
        'github.com',
        'stackoverflow.com',
        'nowcoder.com',
        'juejin.cn',
        'zhihu.com',
        '1point3acres.com',
        'cnblogs.com',
        'csdn.net',
      ],
      credibilityOverrides: {
        'github.com': 5,
        'stackoverflow.com': 4,
        'nowcoder.com': 3,
        'juejin.cn': 3,
        'zhihu.com': 3,
        '1point3acres.com': 3,
        'cnblogs.com': 2,
        'csdn.net': 1,
      },
      freshnessDays: {
        companyIntel: 7,
        interviewReports: 3,
        domainKnowledge: 540,
      },
    });
  });
});
