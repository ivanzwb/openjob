import * as Application from 'expo-application';
import { normalizeVersion } from '@shared/version';

/**
 * 当前安装版本。用 expo-application 而不是 expo-constants：
 * nativeApplicationVersion 读的是已安装 APK 的 versionName，跟用户手里跑的那个包一致。
 *
 * 单独成一个模块，是因为同步链路每轮都要用它上报版本，而升级模块还牵着
 * 文件系统与安装器，不该被拖进同步这条路径。
 */
export function getCurrentVersion(): string {
  return normalizeVersion(Application.nativeApplicationVersion ?? '0.0.0');
}
