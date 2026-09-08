/**
 * 从 Role Pack 的能力模板实例化 Campaign 能力，并映射证据、覆盖类型和优先级。
 *
 * 只遍历 `input.rolePack.competencyTemplates`，不认识任何具体岗位包。工程能力之所以
 * 不会污染产品、市场岗位，靠的是这里根本没有第二个能力来源，而不是靠某个过滤名单
 * ——过滤名单要随岗位包数量一起长，漏一条就是一个岗位看到一堆算法题。
 *
 * 整条链路是确定性的：同一份岗位包 + JD + 已确认证据，任何时候跑出同一份结果。
 * 覆盖类型沿用 deepDive/gap/landmine/extra 的原义（JD 要 × 简历有），没有另起一套
 * 能力专用的分类——两套覆盖语义并存，UI 上只会变成两个都解释不清的角标。
 */

import type { CandidateEvidence, JdParsed } from '../entities';
import type { CoverageType } from '../enums';
import type { CompetencyTemplate, RolePack } from '../plugins/types';
import type { PriorityWeights } from '../config';
import { computePriority } from '../priority';
import { isConfirmed } from '../evidence/promptEvidence';
import { competencySignature, matchAgainstCompetency, textSignature } from './match';
import { computeEvidenceRisk, computeStageWeight, type CompetencyEvidenceSignal } from './factors';
import type {
  CompetencyDiagnosis,
  CompetencyEvidenceLink,
  DiagnosedCompetency,
} from './types';

/** JD 完全没提到时，岗位包自己的权重还能撑起多少考察概率 */
const PACK_PRIOR_SHARE = 0.35;
const JD_DEMAND_SHARE = 0.65;

/** JD 要求把能力权重最多抬到原来的两倍，再归一化 */
const JD_WEIGHT_BOOST = 1;

/**
 * 证据只能把掌握度播种到 3 分。
 *
 * 简历能证明你做过，证明不了你能在四十分钟里讲清楚——那是练习才给得出的分。
 * 上限压在 3，是为了不让「材料写得漂亮」的能力直接掉出准备清单。
 */
const MASTERY_SEED_CAP = 3;

/** 岗位包既没有任务模板也没有题型时长时的兜底准备成本 */
const FALLBACK_EST_MINUTES = 45;

/** 对账结果的中间态：调权要先看过全部能力，才能算出归一化后的权重 */
interface CompetencyDraft {
  template: CompetencyTemplate;
  jdDemand: number;
  jdRequirements: string[];
  links: CompetencyEvidenceLink[];
  signals: CompetencyEvidenceSignal[];
}

export interface DiagnoseCompetenciesInput {
  rolePack: RolePack;
  jd: JdParsed;
  evidence: readonly CandidateEvidence[];
  /** 下一轮面试的阶段 ID，用来算 stageWeight；不传表示流程还没开始 */
  upcomingStageId?: string | null;
  /** 已有掌握度（键为模板 ID）。没有练习记录时按证据强度播种 */
  masteryByTemplateId?: Readonly<Record<string, number>>;
  priorityWeights?: PriorityWeights;
}

function classifyCoverage(jdWants: boolean, candidateHas: boolean): CoverageType {
  if (jdWants && candidateHas) return 'deepDive';
  if (jdWants) return 'gap';
  if (candidateHas) return 'landmine';
  return 'extra';
}

/**
 * 准备成本取岗位包任务模板时长之和。
 *
 * 排掉挂了 capabilityId 的任务：那些任务要插件启用才会出现在计划里，把它们算进
 * 成本会让没装插件的用户也被扣一遍分。任务模板缺席时退到题型时长——总得有个
 * 与岗位相关的数，不能全岗位共用一个常数。
 */
function estimateMinutes(rolePack: RolePack, template: CompetencyTemplate): number {
  const supported = new Set(template.supportedFormats);
  const taskMinutes = rolePack.taskTemplates
    .filter((task) => task.capabilityId === undefined)
    .filter(
      (task) =>
        task.supportedFormats === undefined ||
        task.supportedFormats.length === 0 ||
        task.supportedFormats.some((formatId) => supported.has(formatId)),
    )
    .reduce((sum, task) => sum + task.defaultMinutes, 0);
  if (taskMinutes > 0) return Math.max(1, Math.round(taskMinutes));

  const formatMinutes = rolePack.interviewFormats
    .filter((format) => supported.has(format.id))
    .reduce((max, format) => Math.max(max, format.defaultDurationMinutes), 0);
  return formatMinutes > 0 ? Math.round(formatMinutes) : FALLBACK_EST_MINUTES;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 能力诊断。
 *
 * 返回 Promise 是为了对齐 T11 约定的公开签名，也给后续「用面经和公司情报修正考察
 * 概率」留出异步入口；当前实现全程同步，没有任何模型调用。
 */
export async function diagnoseCompetencies(
  input: DiagnoseCompetenciesInput,
): Promise<CompetencyDiagnosis> {
  const { rolePack, jd } = input;
  const requirements = jd.requirements ?? [];
  // fail closed：proposed / rejected 的材料不参与诊断，否则一条没人看过的抽取
  // 就能改掉覆盖类型和排序
  const confirmed = input.evidence.filter(isConfirmed);
  const upcomingStageId = input.upcomingStageId ?? null;

  const maxDefaultWeight = rolePack.competencyTemplates.reduce(
    (max, template) => Math.max(max, template.defaultWeight),
    0,
  );
  const coveredRequirements = new Set<number>();

  const drafts: CompetencyDraft[] = rolePack.competencyTemplates.map((template) => {
    const signature = competencySignature(template);

    let jdDemand = 0;
    const jdRequirements: string[] = [];
    requirements.forEach((requirement, index) => {
      const match = matchAgainstCompetency(signature, requirement.skill);
      if (!match.matched) return;
      coveredRequirements.add(index);
      jdDemand += Number.isFinite(requirement.weight) ? Math.max(0, requirement.weight) : 0;
      jdRequirements.push(requirement.skill);
    });

    const links: CompetencyEvidenceLink[] = [];
    const signals: CompetencyEvidenceSignal[] = [];
    for (const evidence of confirmed) {
      // evidenceKinds 是岗位包对「什么算这项能力的证据」的声明，当过滤器用而不是
      // 提示：一段代码重构经历不该因为词面撞上就去支撑「客户沟通」
      if (template.evidenceKinds.length > 0 && !template.evidenceKinds.includes(evidence.kind)) {
        continue;
      }
      const match = matchAgainstCompetency(
        signature,
        `${evidence.title} ${evidence.statement}`,
      );
      if (!match.matched) continue;
      links.push({
        evidenceId: evidence.id,
        relevance: match.relevance,
        rationale: `与「${template.name}」共享：${match.hits.slice(0, 3).join('、')}`,
      });
      signals.push({
        kind: evidence.kind,
        confidence: evidence.confidence,
        relevance: match.relevance,
      });
    }

    return { template, jdDemand: clamp01(jdDemand), jdRequirements, links, signals };
  });

  const boostedTotal = drafts.reduce(
    (sum, draft) => sum + draft.template.defaultWeight * (1 + JD_WEIGHT_BOOST * draft.jdDemand),
    0,
  );

  const competencies: DiagnosedCompetency[] = drafts.map((draft) => {
    const { template } = draft;
    const risk = computeEvidenceRisk(draft.signals);
    const stage = computeStageWeight({
      stages: rolePack.interviewStages,
      formatIds: template.supportedFormats,
      upcomingStageId,
    });

    const coverageType = classifyCoverage(draft.jdDemand > 0, draft.links.length > 0);
    const packSalience = maxDefaultWeight > 0 ? template.defaultWeight / maxDefaultWeight : 0;
    const examProb = clamp01(
      PACK_PRIOR_SHARE * packSalience + JD_DEMAND_SHARE * draft.jdDemand,
    );
    const boosted = template.defaultWeight * (1 + JD_WEIGHT_BOOST * draft.jdDemand);
    const weight = boostedTotal > 0 ? boosted / boostedTotal : template.defaultWeight;
    const known = input.masteryByTemplateId?.[template.id];
    const mastery =
      typeof known === 'number' && Number.isFinite(known)
        ? Math.min(5, Math.max(0, known))
        : MASTERY_SEED_CAP * risk.evidenceStrength;
    const estMinutes = estimateMinutes(rolePack, template);

    const priority = computePriority(
      { id: template.id, coverageType, examProb, mastery, estMinutes },
      input.priorityWeights,
      { evidenceRisk: risk.evidenceRisk, stageWeight: stage.stageWeight },
    );

    return {
      templateId: template.id,
      rolePackId: rolePack.manifest.id,
      name: template.name,
      category: template.category,
      weight,
      defaultWeight: template.defaultWeight,
      coverageType,
      jdDemand: draft.jdDemand,
      jdRequirements: draft.jdRequirements,
      examProb,
      mastery,
      estMinutes,
      evidenceStrength: risk.evidenceStrength,
      evidenceRisk: risk.evidenceRisk,
      stageWeight: stage.stageWeight,
      stageIds: stage.stageIds,
      evidence: draft.links,
      priority,
    };
  });

  // 同分时按模板 ID 定序，避免两次诊断给出不同的清单顺序
  competencies.sort(
    (a, b) => b.priority.score - a.priority.score || a.templateId.localeCompare(b.templateId),
  );

  // 整条都是套话的要求（「有相关经验者优先」）删掉套话后什么都不剩，无从判断有没有
  // 被接住。宁可漏报也不报它：把它列成缺口，用户每次打开清单都要重新忽略一遍。
  const uncoveredRequirements = requirements
    .map((requirement, index) => ({ requirement, index }))
    .filter(
      ({ index, requirement }) =>
        !coveredRequirements.has(index) && textSignature(requirement.skill).size > 0,
    )
    .sort((a, b) => b.requirement.weight - a.requirement.weight)
    .map(({ requirement }) => requirement.skill);

  return {
    rolePackId: rolePack.manifest.id,
    rolePackVersion: rolePack.manifest.version,
    roleTitle: jd.roleTitle,
    upcomingStageId,
    competencies,
    uncoveredRequirements,
  };
}
