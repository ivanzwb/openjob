import type { CapabilityDeclaration } from '@core/plugins/types';
import {
  TABULAR_DATASET_ARTIFACT_TYPE,
  TABULAR_DATASET_SCHEMA_VERSION,
} from '@core/case/dataset';

/** 插入点 E：产品岗位内嵌的表格数据分析能力。解析器类型归本包声明；
 * 文件读取与解析由宿主按授权执行（core/case 领域层双端共享）。 */
export const capabilities: CapabilityDeclaration[] = [
  {
    id: 'analytics-case',
    artifactParsers: [
      {
        artifactType: TABULAR_DATASET_ARTIFACT_TYPE,
        schemaVersion: TABULAR_DATASET_SCHEMA_VERSION,
        permission: 'artifact:read',
      },
    ],
  },
];
