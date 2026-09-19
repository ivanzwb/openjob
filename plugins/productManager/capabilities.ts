import type { CapabilityDeclaration } from '@core/plugins/types';
import {
  TABULAR_DATASET_ARTIFACT_TYPE,
  TABULAR_DATASET_SCHEMA_VERSION,
} from './desktop/ui/case-data';
import { ANALYTICS_CASE_CAPABILITY_ID } from './ids';

/** 插入点 E：产品岗位内嵌的表格数据分析能力。解析器类型归本包声明；
 * 文件读取由宿主按授权执行（artifact 原语），表格契约与解析归本包自己所有。 */
export const capabilities: CapabilityDeclaration[] = [
  {
    id: ANALYTICS_CASE_CAPABILITY_ID,
    artifactParsers: [
      {
        artifactType: TABULAR_DATASET_ARTIFACT_TYPE,
        schemaVersion: TABULAR_DATASET_SCHEMA_VERSION,
        permission: 'artifact:read',
      },
    ],
    // 「案例训练」页用的通用原语：读用户显式提供的表格（上一条解析器已贡献
    // artifact:read）之外，出题 / 评分 / 推荐答案走宿主的 LLM 网关，需要 llm:complete。
    // manifest.permissions 必须等于这里的并集（contracts 校验）。
    permissions: ['llm:complete'],
  },
];
