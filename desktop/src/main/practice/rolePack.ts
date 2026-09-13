/**
 * 从 campaignId 取到「当时那一套」岗位包。
 *
 * 拿 descriptor 里的精确版本去查，而不是取本机最新：同一次练习的出题与评分必须用
 * 同一套题型和量规，岗位包升级之后回头复核一次旧评分，也只有精确版本能解释当时的
 * 锚点是什么。查不到就报错停下，不退化到「用个差不多的版本」——那会让 provenance
 * 里记的版本和实际用的文本对不上。
 *
 * 读历史那条链路（getCampaignPracticePack）不报错：descriptor 缺包时返回 null，
 * 让历史投影按空串兜底，而不是让「读旧记录」因为「没装包」炸掉。
 */

import type { Database } from 'better-sqlite3';
import { PracticeError } from '@core/practice';
import type { CampaignRuntimeDescriptor, RolePack } from '@core/plugins/types';
import { findInstalledRolePack, findLatestRolePack, getCampaignRuntime } from '../plugins/runtime';

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
  // pin 版本优先（复核旧评分要当时的量规）；不在本机时退回同 id 最新已装包——
  // 插件装上即功能一致，不允许「装了插件还练不了」；每次 attempt 记录
  // rubric/prompt 版本，历史可解释性由逐条 provenance 承担
  const rolePack = findRolePack(ref.id, ref.version) ?? findLatestRolePack(ref.id);
  if (!rolePack) {
    throw new PracticeError(
      'role-pack-unavailable',
      `本机没有安装岗位包 ${ref.id}，请在插件设置中安装后再练习`,
    );
  }

  return {
    descriptor: view.descriptor,
    rolePack,
    interviewLanguage: view.roleProfile?.interviewLanguage ?? 'zh',
  };
}

/**
 * 读历史用的岗位包解析：descriptor 缺包不报错，返回 null 让投影按空串兜底。
 *
 * 与出题链路（resolveCampaignPracticeRuntime）的区别只在缺包行为——读历史不该因为
 * 「没装包」而炸掉，装了什么就按什么投影，什么都没装就诚实地留空。
 */
export function getCampaignPracticePack(raw: Database, campaignId: string): RolePack | null {
  const view = getCampaignRuntime(raw, campaignId);
  if (!view) return null;
  const ref = view.descriptor.rolePack;
  return findRolePack(ref.id, ref.version) ?? findLatestRolePack(ref.id);
}
