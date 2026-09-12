import { LEGACY_ROLE_PACK_REF } from '@core/plugins/legacyRoleData';

/**
 * 岗位包与历史数据共用同一组 id：本包已经被 pin 进旧 Campaign 的 descriptor 与
 * quiz/design 投影，两处各写一份迟早会分叉，而分叉的表现是旧记录换了套量规。
 * 定义留在宿主的 legacyRoleData（基础包不带岗位包，宿主读旧数据时也得认得这些 id）。
 */
export const SOFTWARE_ENGINEERING_ROLE_PACK_ID = LEGACY_ROLE_PACK_REF.id;

/**
 * 岗位包自身的版本与旧数据无关了：id 仍沿用 LEGACY_ROLE_PACK_REF.id（旧 Campaign 的
 * descriptor 与题型投影 pin 着它），但包内容换代时版本要跟着走，
 * 否则解析器会把新旧两份包当成同一份。
 */
export const SOFTWARE_ENGINEERING_ROLE_PACK_VERSION = '1.2.0';
