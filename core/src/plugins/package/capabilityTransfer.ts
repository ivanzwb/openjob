/**
 * 能力包在「发布包」里的形态。
 *
 * 与 rolePackTransfer 对称：`scripts/pack-plugins.mjs` 打能力合编包时走的也是这里，
 * 「能力包怎么拆成 manifest.json + contributions.json」只有这一处定义。手机端不走这条
 * 路——能力包不下发（工具实现全在桌面宿主，手机只判视图），所以这里没有 transfer 解析。
 */
import type { CapabilityPlugin } from '../types';
import {
  PACKAGE_CONTRIBUTIONS_FILE,
  PACKAGE_MANIFEST_FILE,
  type PluginPackageFiles,
} from './contract';
import { recordContributions } from './replay';

export function capabilityPluginToPackageFiles(plugin: CapabilityPlugin): PluginPackageFiles {
  return {
    [PACKAGE_MANIFEST_FILE]: JSON.stringify(plugin.manifest),
    [PACKAGE_CONTRIBUTIONS_FILE]: JSON.stringify(recordContributions(plugin)),
  };
}
