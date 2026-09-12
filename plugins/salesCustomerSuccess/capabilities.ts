import type { CapabilityDeclaration } from '@core/plugins/types';

/** 插入点 E：销售岗位内嵌的能力（客户对话角色扮演，含语音作答）。 */
export const capabilities: CapabilityDeclaration[] = [{ id: 'role-play' }];
