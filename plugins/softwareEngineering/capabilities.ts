import type { CapabilityDeclaration } from '@core/plugins/types';

/**
 * 插入点 E：工程岗位内嵌的能力。
 *
 * 包只声明「选用哪个宿主已知能力」——工具贡献契约与执行实现都长在宿主，
 * manifest.permissions 必须等于这些能力的权限并集（契约校验强制）。
 */
export const capabilities: CapabilityDeclaration[] = [{ id: 'source-repository' }];
