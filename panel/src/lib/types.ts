export type Micros = string;

export type Totals = {
  impressions: number; clicks: number; ctr: number;
  spendMicros: Micros; payoutMicros: Micros; platformMicros: Micros;
  ecpmMicros: Micros; ecpcMicros: Micros;
};

export type SeriesPoint = {
  date: string; impressions: number; clicks: number;
  spendMicros: Micros; payoutMicros: Micros; platformMicros: Micros;
};

export type GeoRow = {
  key: string; country: string; state: string; city: string; area: string;
  impressions: number; clicks: number; spendMicros: Micros;
};

export type HostRow = { hostApp: string; impressions: number; spendMicros: Micros; payoutMicros: Micros };

export type CampaignRow = {
  campaignId: string; name: string; vendor: string; status: string;
  impressions: number; clicks: number; ctr: number; spendMicros: Micros;
};

export type GeoRule = { id?: string; mode: 'INCLUDE' | 'EXCLUDE'; country: string; state: string; city: string; area: string };

export type Ad = {
  id: string; campaignId: string; headline: string; body: string; imageUrl: string | null;
  ctaText: string; clickUrl: string; accent: string; weight: number; status: string;
  impressionCount: number; clickCount: number; createdAt: string;
};

export type Campaign = {
  id: string; vendorId: string; name: string; status: string; category: string;
  pricingModel: 'CPM' | 'CPC' | 'CPM_CPC';
  cpmMicros: Micros; cpcMicros: Micros;
  totalBudgetMicros: Micros; dailyBudgetMicros: Micros; spentMicros: Micros;
  startAt: string; endAt: string; dayparting: string | null;
  frequencyCapPerDay: number; priority: number; reviewNote: string | null;
  createdAt: string;
  geoRules: GeoRule[]; ads: Ad[];
  vendor?: { id: string; companyName: string; balanceMicros: Micros; status: string };
  stats?: { impressions: number; clicks: number; ctr: number };
  budgetUsedPct?: number;
};

export type Vendor = {
  id: string; companyName: string; website: string | null; country: string | null;
  status: string; balanceMicros: Micros; lifetimeSpendMicros: Micros; lifetimeTopUpMicros: Micros;
  notes: string | null; createdAt: string;
  user?: { id: string; email: string; name: string; status: string; lastLoginAt: string | null };
  _count?: { campaigns: number };
};

export type Publisher = {
  id: string; displayName: string; balanceMicros: Micros; lifetimeEarnedMicros: Micros; paidOutMicros: Micros;
  payoutMethod: string | null; payoutDetails: string | null;
  country: string | null; state: string | null; city: string | null; area: string | null;
  adsEnabled: boolean; blockedCategories: string;
  /** null means the account inherits the platform pacing policy. */
  maxAdsPerHour: number | null; minSecondsBetweenAds: number | null;
  createdAt: string; updatedAt?: string;
  user?: { id: string; email: string; name: string; status: string; lastLoginAt: string | null; createdAt: string };
  _count?: { devices: number; impressions: number };
};

export type Device = {
  id: string; label: string; platform: string | null; browser: string | null; extVersion: string | null;
  lastSeenAt: string | null; revokedAt: string | null; createdAt: string;
  pending?: boolean; _count?: { impressions: number };
};

export type LedgerEntry = {
  id: string; createdAt: string; type: string; amountMicros: Micros; account: string;
  vendorId: string | null; publisherId: string | null; impressionId: string | null;
  balanceAfter: Micros | null; note: string; createdBy: string | null;
  vendor?: { companyName: string } | null;
  publisher?: { displayName: string } | null;
  impression?: { hostApp: string; country: string; city: string; status: string; ad: { headline: string } } | null;
};

export type Payout = {
  id: string; publisherId: string; amountMicros: Micros; method: string; details: string;
  status: string; requestedAt: string; processedAt: string | null; reference: string; note: string;
  publisher?: { id: string; displayName: string; balanceMicros: Micros; country: string | null; city: string | null; user: { email: string; name: string } };
};

export type Recharge = {
  id: string; vendorId: string; amountMicros: Micros; method: string; reference: string;
  status: string; createdAt: string; settledAt: string | null; note: string;
  vendor?: { id: string; companyName: string; balanceMicros: Micros };
};

export type Impression = {
  id: string; servedAt: string; status: string; hostApp: string; modelHint: string;
  country: string; state: string; city: string; area: string;
  costMicros: Micros; payoutMicros: Micros; platformMicros: Micros; dwellMs: number;
  ad: { headline: string }; campaign: { name: string }; vendor?: { companyName: string };
  publisher?: { displayName: string; user: { email: string } } | null;
  click?: { clickedAt: string } | null;
};

export type AuditRow = {
  id: string; createdAt: string; actorRole: string; action: string; entity: string; entityId: string;
  meta: string; ip: string; actor: { email: string; name: string; role: string } | null;
};

export type Paged<T> = { page: number; total: number; pages: number; data: T[] };
