export const ROLES = ['SUPER_ADMIN', 'VENDOR', 'END_USER'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUS = ['ACTIVE', 'SUSPENDED', 'PENDING'] as const;
export const VENDOR_STATUS = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export const CAMPAIGN_STATUS = [
  'DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED',
] as const;
export const AD_STATUS = ['ACTIVE', 'PAUSED', 'REJECTED'] as const;
export const PRICING_MODELS = ['CPM', 'CPC', 'CPM_CPC'] as const;
export const IMPRESSION_STATUS = ['SERVED', 'VIEWED', 'CLICKED', 'EXPIRED', 'VOID'] as const;
export const PAYOUT_STATUS = ['REQUESTED', 'APPROVED', 'PAID', 'REJECTED'] as const;
export const RECHARGE_STATUS = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export const LEDGER_TYPES = [
  'VENDOR_TOPUP', 'VENDOR_SPEND', 'PUBLISHER_EARN', 'PUBLISHER_PAYOUT',
  'PLATFORM_REVENUE', 'ADJUSTMENT', 'REFUND',
] as const;

export const AD_CATEGORIES = [
  'general', 'developer-tools', 'saas', 'ai-ml', 'finance', 'education',
  'ecommerce', 'gaming', 'health', 'travel',
] as const;

/// A served impression must be confirmed within this window or it expires unbilled.
export const IMPRESSION_TTL_MS = 5 * 60 * 1000;
/// Minimum time an ad must be on screen before it counts as a billable view.
export const MIN_VIEW_MS = 1200;
