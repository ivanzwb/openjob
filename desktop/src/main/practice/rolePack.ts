/**
 * 从 campaignId 取到「当时那一套」岗位包。
 *
 * 拿 descriptor 里的精确版本去查，而不是取本机最新：同一次练习的出题与评分必须用
 * 同一套题型和量规，岗位包升级之后回头复核一次旧评分，也只有精确版本能解释当时的
 * 锚点是什么。查不到就报错停下，不退化到「用个差不多的版本」——那会让 provenance
 * 里记的版本和实际用的文本对不上。
 */

import type { Database } from 'better-sqlite3';
import type { ExamForm } from '@core/enums';
import { PracticeError } from '@core/practice';
import { LEGACY_EXAM_FORM_TO_FORMAT_ID } from '@core/plugins/legacyRoleData';
import type { CampaignRuntimeDescriptor, RolePack } from '@core/plugins/types';
import { findInstalledRolePack, getCampaignRuntime } from '../plugins/runtime';

/**
 * formatId → 旧 ExamForm 的反向映射。
 *
 * 由正向表推导而不是再写一份：design.case / design.score 这些 build 型 prompt 的
 * 参数仍然按旧的题型取值分支，两张表对不上就会静默取到另一套题目模板。
 */
const FORMAT_ID_TO_LEGACY_EXAM_FORM: Readonly<Record<string, ExamForm>> = Object.fromEntries(
  Object.entries(LEGACY_EXAM_FORM_TO_FORMAT_ID).map(([examForm, formatId]) => [
    formatId,
    examForm as ExamForm,
  ]),
);

/** 岗位包新增的题型没有旧取值时退回 design：build 型 prompt 必须拿到一个合法分支。 */
export function legacyExamFormForFormatId(formatId: string): ExamForm {
  return FORMAT_ID_TO_LEGACY_EXAM_FORM[formatId] ?? 'design';
}

export interface CampaignPracticeRuntime {
  descriptor: CampaignRuntimeDescriptor;
  rolePack: RolePack;
  /** 岗位意图里的面试语言，透传给按语言分支的 prompt */
  interviewLanguage: string;
}

/**
 * 岗位包一律来自本机安装清单：基础包不带任何岗位包，用户装了哪几个就只有哪几个。
 *
 * 「缺包」因此是常态而不是异常——用户可以卸载，也可以只装新版本。缺包的处理见
 * `resolveCampaignPracticeRuntime`：出题这条链路停下，读历史那条链路不受影响。
 */
export function findRolePack(id: string, version: string): RolePack | null {
  return findInstalledRolePack(id, version);
}

export function resolveCampaignPracticeRuntime(
  raw: Database,
  campaignId: string,
): CampaignPracticeRuntime {
  const view = getCampaignRuntime(raw, campaignId);
  if (!view) {
    throw new PracticeError(
      'campaign-not-found',
      `Campaign ${campaignId} 还没有插件运行时描述符`,
    );
  }

  const ref = view.descriptor.rolePack;
  const rolePack = findRolePack(ref.id, ref.version);
  if (!rolePack) {
    throw new PracticeError(
      'role-pack-unavailable',
      `本机没有岗位包 ${ref.id}@${ref.version}，无法按当时的题型与量规练习`,
    );
  }

  return {
    descriptor: view.descriptor,
    rolePack,
    interviewLanguage: view.roleProfile?.interviewLanguage ?? 'zh',
  };
}
