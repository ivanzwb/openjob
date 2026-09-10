/**
 * Campaign 级的能力诊断入口。
 *
 * 结果不落库，每次按需算。三个输入（岗位包精确版本、jd_parsed、已确认证据）本来
 * 就都在库里，再存一份诊断结果只会多出一类必须手动失效的缓存：用户确认一条证据、
 * 改一句 JD、换一个岗位包版本，存下来的那份就已经在骗人了。加一张表还是永久成本
 * ——迁移写下去就删不掉。
 *
 * 岗位包一律从 Campaign 的 runtime descriptor 取，不 import 任何具体岗位包：非工程
 * 岗位看不到工程能力，靠的是这里没有第二个能力来源。
 */

import type { Database } from 'better-sqlite3';
import type { JdParsed } from '@core/entities';
import { diagnoseCompetencies, type CompetencyDiagnosis } from '@core/competency';
import { listConfirmedEvidence } from '../evidence/repository';
import { resolveCampaignPracticeRuntime } from '../practice/rolePack';

export interface CampaignCompetencyDeps {
  raw: Database;
}

export interface CampaignCompetencyInput {
  campaignId: string;
  /** 下一轮面试；不传按流程还没开始算 */
  upcomingStageId?: string | null;
}

interface CampaignRow {
  role_title: string;
  jd_parsed: string | null;
}

/**
 * JD 还没解析时用岗位标题兜底。
 *
 * 不抛错：能力模板来自岗位包，没有 JD 只是少了调权和覆盖类型的一半输入，清单本身
 * 仍然成立，用户至少能看到这个岗位要考什么。
 */
function readJdParsed(raw: Database, campaignId: string): JdParsed {
  const row = raw
    .prepare(`SELECT role_title, jd_parsed FROM campaign WHERE id = ?`)
    .get(campaignId) as CampaignRow | undefined;
  if (!row) throw new Error(`Campaign 不存在：${campaignId}`);

  if (row.jd_parsed) {
    const parsed = JSON.parse(row.jd_parsed) as JdParsed;
    return {
      roleTitle: parsed.roleTitle || row.role_title,
      requirements: parsed.requirements ?? [],
      seniority: parsed.seniority ?? null,
    };
  }
  return { roleTitle: row.role_title, requirements: [], seniority: null };
}

export async function diagnoseCampaignCompetencies(
  deps: CampaignCompetencyDeps,
  input: CampaignCompetencyInput,
): Promise<CompetencyDiagnosis> {
  const { rolePack } = resolveCampaignPracticeRuntime(deps.raw, input.campaignId);
  return diagnoseCompetencies({
    rolePack,
    jd: readJdParsed(deps.raw, input.campaignId),
    evidence: listConfirmedEvidence(deps.raw, { campaignId: input.campaignId }),
    upcomingStageId: input.upcomingStageId ?? null,
  });
}
