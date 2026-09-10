/**
 * 能力诊断的用例。
 *
 * 四条验收标准各自对应一组用例：覆盖类型只能是既有的四个取值；能力名称必须保持
 * 人能读的中文；evidenceRisk / stageWeight 要能从输入复算出来；换成非工程岗位包时
 * 不能冒出任何工程能力。最后一条是这一版最容易回归的地方——只要有人图省事在诊断
 * 里 import 一次内置工程包，产品经理的清单里就会出现算法题，而类型系统不会报错。
 */
import { describe, expect, it } from 'vitest';
import type { CandidateEvidence, JdParsed } from '../entities';
import type { CandidateEvidenceKind, EvidenceStatus } from '../enums';
import { validateRolePack } from '../plugins/contracts';
import { SOFTWARE_ENGINEERING_FORMAT_IDS } from '../plugins/legacyRoleData';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { productManagementRolePack } from './__fixtures__/productManagementRolePack';
import { computeEvidenceRisk, computeStageWeight } from './factors';
import { diagnoseCompetencies } from './diagnose';

function evidence(
  id: string,
  kind: CandidateEvidenceKind,
  title: string,
  statement: string,
  options: { confidence?: number; status?: EvidenceStatus } = {},
): CandidateEvidence {
  return {
    id,
    campaignId: 'c-acme',
    kind,
    title,
    statement,
    source: { kind: 'resume', documentId: 'r-1', start: 0, end: statement.length, quote: statement },
    occurredAt: null,
    confidence: options.confidence ?? 0.9,
    status: options.status ?? 'confirmed',
    createdAt: 1,
    updatedAt: 1,
  };
}

const SE_JD: JdParsed = {
  roleTitle: '后端工程师',
  seniority: 'senior',
  requirements: [
    { skill: '熟悉分布式系统设计与高并发架构', weight: 0.4 },
    { skill: '扎实的数据结构与算法基础', weight: 0.3 },
    { skill: '负责线上服务的稳定性与可观测性建设', weight: 0.2 },
    { skill: '有良好的团队协作与沟通能力', weight: 0.1 },
  ],
};

const SE_EVIDENCE: CandidateEvidence[] = [
  evidence(
    'e-design',
    'experience',
    '订单系统重构',
    '主导订单系统设计重构，把 P99 延迟从 800ms 降到 120ms',
  ),
  evidence('e-algo', 'skill', '算法', '熟练掌握常见数据结构与算法，刷题 500 道以上', {
    confidence: 0.95,
  }),
  evidence(
    'e-oss',
    'experience',
    '开源项目',
    '负责一个开源项目的技术决策与复盘，个人贡献占比 70%',
  ),
  evidence('e-unconfirmed', 'achievement', '交付质量', '推动可观测性建设，评审与发布流程全覆盖', {
    status: 'proposed',
  }),
];

async function diagnoseSe() {
  return diagnoseCompetencies({
    rolePack: softwareEngineeringRolePack,
    jd: SE_JD,
    evidence: SE_EVIDENCE,
    upcomingStageId: 'se.coding-interview',
  });
}

describe('diagnoseCompetencies', () => {
  it('能力清单逐条来自岗位包模板，不多不少', async () => {
    const diagnosis = await diagnoseSe();
    expect(diagnosis.competencies.map((item) => item.templateId).sort()).toEqual(
      softwareEngineeringRolePack.competencyTemplates.map((item) => item.id).sort(),
    );
    expect(diagnosis.rolePackVersion).toBe(softwareEngineeringRolePack.manifest.version);
  });

  it('沿用 deepDive/gap/landmine/extra，按 JD 要不要 × 简历有没有交叉判定', async () => {
    const diagnosis = await diagnoseSe();
    const byId = new Map(diagnosis.competencies.map((item) => [item.templateId, item]));

    // JD 要 + 有证据
    expect(byId.get('se.system-design')?.coverageType).toBe('deepDive');
    // JD 要 + 没证据
    expect(byId.get('se.computer-science-foundations')?.coverageType).toBe('gap');
    // 简历写了 + JD 没要
    expect(byId.get('se.technical-project-depth')?.coverageType).toBe('landmine');
    // 都没有
    expect(byId.get('se.software-delivery')?.coverageType).toBe('gap');

    const coverages = new Set(diagnosis.competencies.map((item) => item.coverageType));
    for (const coverage of coverages) {
      expect(['deepDive', 'gap', 'landmine', 'extra']).toContain(coverage);
    }
  });

  it('未确认的证据一条都不参与诊断', async () => {
    const diagnosis = await diagnoseSe();
    const linked = diagnosis.competencies.flatMap((item) =>
      item.evidence.map((link) => link.evidenceId),
    );
    expect(linked).not.toContain('e-unconfirmed');

    const confirmedOnly = await diagnoseCompetencies({
      rolePack: softwareEngineeringRolePack,
      jd: SE_JD,
      evidence: SE_EVIDENCE.filter((item) => item.status === 'confirmed'),
      upcomingStageId: 'se.coding-interview',
    });
    expect(confirmedOnly).toEqual(diagnosis);
  });

  it('能力名称保持岗位包里的中文，不退化成模板 ID', async () => {
    const diagnosis = await diagnoseSe();
    for (const competency of diagnosis.competencies) {
      const template = softwareEngineeringRolePack.competencyTemplates.find(
        (item) => item.id === competency.templateId,
      );
      expect(competency.name).toBe(template?.name);
      expect(competency.name).not.toContain(competency.templateId);
      expect(competency.name).not.toMatch(/^[a-z0-9.-]+$/);
      // 排序依据同样要人能读：优先级是 Agent 的核心输出，不能是个裸分数
      expect(competency.priority.reason).toContain('分钟');
    }
  });

  it('evidenceRisk 能从证据种类复算出来：只有技能声称的能力风险最高', async () => {
    const diagnosis = await diagnoseSe();
    const byId = new Map(diagnosis.competencies.map((item) => [item.templateId, item]));

    const coding = byId.get('se.coding-and-algorithms');
    const design = byId.get('se.system-design');
    expect(coding?.evidenceStrength).toBe(0);
    expect(coding?.evidenceRisk).toBeGreaterThan(design?.evidenceRisk ?? 0);

    const expected = computeEvidenceRisk(
      coding!.evidence.map((link) => ({
        kind: 'skill' as const,
        confidence: 0.95,
        relevance: link.relevance,
      })),
    );
    expect(coding?.evidenceRisk).toBeCloseTo(expected.evidenceRisk, 10);

    // 没有任何证据的能力不该被算成「说了没证据」
    expect(byId.get('se.software-delivery')?.evidenceRisk).toBe(1);
  });

  it('stageWeight 跟着下一轮走，且与独立计算一致', async () => {
    const diagnosis = await diagnoseSe();
    const byId = new Map(diagnosis.competencies.map((item) => [item.templateId, item]));
    const coding = byId.get('se.coding-and-algorithms');

    expect(coding?.stageIds).toEqual(['se.coding-interview']);
    expect(coding?.stageWeight).toBeCloseTo(
      computeStageWeight({
        stages: softwareEngineeringRolePack.interviewStages,
        formatIds: [SOFTWARE_ENGINEERING_FORMAT_IDS.coding],
        upcomingStageId: 'se.coding-interview',
      }).stageWeight,
      10,
    );

    // 换一轮，同一份输入必须给出不同的轮次权重
    const later = await diagnoseCompetencies({
      rolePack: softwareEngineeringRolePack,
      jd: SE_JD,
      evidence: SE_EVIDENCE,
      upcomingStageId: 'se.project-technical-interview',
    });
    const codingLater = later.competencies.find(
      (item) => item.templateId === 'se.coding-and-algorithms',
    );
    expect(codingLater?.stageWeight).toBeLessThan(coding?.stageWeight ?? 0);
  });

  it('优先级得分等于把两个因子乘进原公式', async () => {
    const diagnosis = await diagnoseSe();
    for (const competency of diagnosis.competencies) {
      const target = { deepDive: 5, gap: 3, landmine: 4, extra: 2 }[competency.coverageType];
      const boost = { deepDive: 1.2, gap: 1, landmine: 1.1, extra: 0.8 }[competency.coverageType];
      const expected =
        (competency.examProb *
          Math.max(0, target - competency.mastery) *
          boost *
          competency.evidenceRisk *
          competency.stageWeight) /
        competency.estMinutes;
      expect(competency.priority.score).toBeCloseTo(expected, 10);
    }
  });

  it('JD 调权后能力权重仍然归一，清单按优先级降序', async () => {
    const diagnosis = await diagnoseSe();
    const total = diagnosis.competencies.reduce((sum, item) => sum + item.weight, 0);
    expect(total).toBeCloseTo(1, 10);

    // JD 明确要求的能力权重被抬高
    const design = diagnosis.competencies.find((item) => item.templateId === 'se.system-design');
    expect(design!.weight).toBeGreaterThan(design!.defaultWeight);

    const scores = diagnosis.competencies.map((item) => item.priority.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('同一份输入跑两次结果逐字相同', async () => {
    expect(await diagnoseSe()).toEqual(await diagnoseSe());
  });

  it('JD 里没有能力接得住的要求会被报出来，纯套话不报', async () => {
    const diagnosis = await diagnoseCompetencies({
      rolePack: softwareEngineeringRolePack,
      jd: {
        roleTitle: '后端工程师',
        seniority: null,
        requirements: [
          { skill: '熟悉 Figma 与视觉规范', weight: 0.5 },
          { skill: '有相关经验者优先', weight: 0.5 },
        ],
      },
      evidence: [],
    });
    expect(diagnosis.uncoveredRequirements).toEqual(['熟悉 Figma 与视觉规范']);
  });

  it('已有掌握度优先于按证据播种的值', async () => {
    const diagnosis = await diagnoseCompetencies({
      rolePack: softwareEngineeringRolePack,
      jd: SE_JD,
      evidence: SE_EVIDENCE,
      masteryByTemplateId: { 'se.system-design': 4.5 },
    });
    const design = diagnosis.competencies.find((item) => item.templateId === 'se.system-design');
    expect(design?.mastery).toBe(4.5);
  });

  it('证据最多把掌握度播种到 3 分——简历证明不了你能讲清楚', async () => {
    const diagnosis = await diagnoseSe();
    for (const competency of diagnosis.competencies) {
      expect(competency.mastery).toBeLessThanOrEqual(3);
    }
  });
});

describe('非工程岗位包', () => {
  it('测试用的产品岗位包本身满足插件契约', () => {
    expect(validateRolePack(productManagementRolePack)).toEqual([]);
  });

  it('即使喂进工程味十足的 JD 和证据，也不产生任何工程能力', async () => {
    const diagnosis = await diagnoseCompetencies({
      rolePack: productManagementRolePack,
      jd: {
        roleTitle: '产品经理',
        seniority: null,
        requirements: [
          { skill: '熟悉分布式系统设计与高并发架构', weight: 0.5 },
          { skill: '能独立完成用户调研并输出结论', weight: 0.5 },
        ],
      },
      evidence: [
        evidence('e-code', 'skill', '编码', '精通 Java 与数据结构算法，能独立完成系统设计'),
        evidence('e-research', 'experience', '用户调研', '组织 30 场用户访谈并输出可行动的调研结论'),
      ],
      upcomingStageId: 'pm.case-interview',
    });

    const ids = diagnosis.competencies.map((item) => item.templateId);
    expect(ids.every((id) => !id.startsWith('se.'))).toBe(true);
    expect(ids.sort()).toEqual(
      productManagementRolePack.competencyTemplates.map((item) => item.id).sort(),
    );
    expect(diagnosis.rolePackId).toBe('product-management');

    const names = diagnosis.competencies.map((item) => item.name).join('');
    expect(names).not.toContain('算法');
    expect(names).not.toContain('系统设计');

    // 工程要求没有能力接得住时只会进「未覆盖」，不会凭空长出一个工程能力
    expect(diagnosis.uncoveredRequirements).toContain('熟悉分布式系统设计与高并发架构');
  });

  it('准备成本来自岗位包自己的任务模板，不是全局常数', async () => {
    const diagnosis = await diagnoseCompetencies({
      rolePack: productManagementRolePack,
      jd: { roleTitle: '产品经理', seniority: null, requirements: [] },
      evidence: [],
    });
    const byId = new Map(diagnosis.competencies.map((item) => [item.templateId, item]));
    // pm.learn 25 + pm.drill 20
    expect(byId.get('pm.problem-framing')?.estMinutes).toBe(45);
    // pm.learn 25 + pm.drill 20 + pm.story 15
    expect(byId.get('pm.user-insight')?.estMinutes).toBe(60);
    // pm.learn 25 + pm.story 15
    expect(byId.get('pm.stakeholder-alignment')?.estMinutes).toBe(40);
  });
});
