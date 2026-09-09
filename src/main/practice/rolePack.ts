/**
 * 从 campaignId 取到「当时那一套」岗位包。
 *
 * 拿 descriptor 里的精确版本去查，而不是取本机最新：同一次练习的出题与评分必须用
 * 同一套题型和量规，岗位包升级之后回头复核一次旧评分，也只有精确版本能解释当时的
 * 锚点是什么。查不到就报错停下，不退化到「用个差不多的版本」——那会让 provenance
 * 里记的版本和实际用的文本对不上。
 */

import type { Database } from 'better-sqlite3';
import type { ExamForm } from '@shared/enums';
import { PracticeError } from '@shared/practice';
import { BUILT_IN_ROLE_PACKS } from '@shared/plugins/builtin';
import { LEGACY_EXAM_FORM_TO_FORMAT_ID } from '@shared/plugins/builtin/softwareEngineering';
import type { CampaignRuntimeDescriptor, RolePack } from '@shared/plugins/types';
import { getCampaignRuntime } from '../plugins/runtime';

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

export function findRolePack(id: string, version: string): RolePack | null {
  return (
    BUILT_IN_ROLE_PACKS.find(
      (pack) => pack.manifest.id === id && pack.manifest.version === version,
    ) ?? null
  );
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
