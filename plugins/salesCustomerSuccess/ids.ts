import { CORE_CAPABILITIES_PACK_ID } from '@core/plugins/capabilitySuite';

export const SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID = 'sales-customer-success';
export const SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION = '1.2.0';

/**
 * 可选能力：装了才有实时角色扮演，没装时对话轮退回文本行为题。
 *
 * 角色扮演来自能力合编包（原内置 role-play 并入 openjob-capabilities）。
 */
export const SALES_ROLE_PLAY_CAPABILITY_ID = CORE_CAPABILITIES_PACK_ID;

export const SALES_CUSTOMER_SUCCESS_FORMAT_IDS = {
  behavioral: 'sales.behavioral',
  customerRolePlay: 'sales.customer-role-play',
} as const;

export const SALES_CUSTOMER_SUCCESS_COMPETENCY_IDS = {
  discovery: 'sales.discovery',
  valueArticulation: 'sales.value-articulation',
  objectionHandling: 'sales.objection-handling',
  negotiation: 'sales.negotiation',
  pipeline: 'sales.pipeline',
} as const;

export const SALES_CUSTOMER_SUCCESS_RUBRIC_IDS = {
  behavioral: 'sales.behavioral-rubric',
  rolePlay: 'sales.role-play-rubric',
} as const;
