/**
 * 能力诊断的结果形态。
 *
 * 字段对齐架构文档 10.1 的 Competency / CompetencyEvidence，但多带了 evidenceRisk、
 * stageWeight 和 priority：诊断本身不落库，谁需要解释「为什么这条排在前面」，
 * 就必须在同一份结果里看到全部输入，否则只能拿着一个分数去猜。
 */

import type { CompetencyCategory, CoverageType } from '../enums';
import type { Id, PriorityBreakdown } from '../entities';

/** 一条候选人证据对某项能力的支撑 */
export interface CompetencyEvidenceLink {
  evidenceId: Id;
  /** 0–1，文本相关度；不是证据本身的可信度 */
  relevance: number;
  /** 为什么判定这条证据落在这项能力上，给用户看的 */
  rationale: string;
}

export interface DiagnosedCompetency {
  /** 岗位包里的模板 ID，跨 Campaign 稳定 */
  templateId: string;
  rolePackId: string;
  /** 直接取自模板的中文名，任何投影都不许换成 ID */
  name: string;
  category: CompetencyCategory;
  /** JD 调权并归一化之后的能力权重，全部能力之和为 1 */
  weight: number;
  /** 岗位包原始权重，用来解释调权幅度 */
  defaultWeight: number;
  coverageType: CoverageType;
  /** 0–1，JD 中命中本能力的要求权重之和 */
  jdDemand: number;
  /** 命中本能力的 JD 要求原文 */
  jdRequirements: string[];
  examProb: number;
  /** 0–5，无练习记录时按证据强度播种 */
  mastery: number;
  estMinutes: number;
  /** 0–1，可佐证的证据有多硬 */
  evidenceStrength: number;
  /** 1–2，声称强度减去证据强度 */
  evidenceRisk: number;
  /** 0.6–1.4，下一轮就考的更高 */
  stageWeight: number;
  /** 会考察本能力的面试轮次 */
  stageIds: string[];
  evidence: CompetencyEvidenceLink[];
  priority: PriorityBreakdown;
}

export interface CompetencyDiagnosis {
  rolePackId: string;
  rolePackVersion: string;
  roleTitle: string;
  /** 下一轮面试；null 表示流程还没开始 */
  upcomingStageId: string | null;
  /** 按 priority.score 降序 */
  competencies: DiagnosedCompetency[];
  /** JD 里没有任何能力接得住的要求，按权重降序 */
  uncoveredRequirements: string[];
}
