export const PRODUCT_MANAGER_ROLE_PACK_ID = 'product-manager';
export const PRODUCT_MANAGER_ROLE_PACK_VERSION = '1.0.0';

/** 本包内嵌的能力 id。能力不是独立的包——它与题型、量规一样，都是本包的内容。 */
export const ANALYTICS_CASE_CAPABILITY_ID = 'analytics-case';

/** 可选能力：装了能加强，没装不影响任何一种题型可用。 */
export const PRODUCT_MANAGER_OPTIONAL_CAPABILITY_IDS = {
  analyticsCase: ANALYTICS_CASE_CAPABILITY_ID,
  portfolioReview: 'portfolio-review',
} as const;

export const PRODUCT_MANAGER_FORMAT_IDS = {
  productCase: 'pm.product-case',
  behavioral: 'pm.behavioral',
  presentation: 'pm.product-presentation',
} as const;

export const PRODUCT_MANAGER_COMPETENCY_IDS = {
  problemFraming: 'pm.problem-framing',
  userInsight: 'pm.user-insight',
  metrics: 'pm.metrics',
  prioritization: 'pm.prioritization',
  productDecision: 'pm.product-decision',
} as const;

export const PRODUCT_MANAGER_RUBRIC_IDS = {
  productCase: 'pm.product-case-rubric',
  behavioral: 'pm.behavioral-rubric',
  presentation: 'pm.product-presentation-rubric',
} as const;
