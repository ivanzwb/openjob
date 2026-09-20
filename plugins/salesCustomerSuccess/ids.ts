export const SALES_CUSTOMER_SUCCESS_ROLE_PACK_ID = 'sales-customer-success';
export const SALES_CUSTOMER_SUCCESS_ROLE_PACK_VERSION = '1.0.0';

/**
 * 可选能力：装了才有实时角色扮演，没装时对话轮退回文本行为题。
 *
 * 角色扮演是本包内嵌的能力声明（见 capabilities.ts）：能力不是独立的包，所以这个 id
 * 就是声明自己的名字，题型用 `capabilityId` 指向它。
 */
export const SALES_ROLE_PLAY_CAPABILITY_ID = 'role-play';

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
