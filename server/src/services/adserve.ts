import { prisma } from '../lib/prisma.js';
import { geoMatches, geoSpecificity, type Geo } from '../lib/geo.js';
import { getBool, getNumber } from './settings.js';
import { IMPRESSION_TTL_MS } from '../lib/constants.js';
import { signImpression, hashIp } from '../lib/crypto.js';
import { cache } from '../lib/redis.js';
import { platformDayKey } from '../lib/time.js';
import { scoreServe } from './fraud.js';

export type ServeContext = {
  publisherId: string;
  deviceId: string;
  geo: Geo;
  ip: string;
  hostApp: string;
  modelHint: string;
  excludeAdId?: string;
};

export type ServeResult =
  | { ok: true; ad: ServedAd }
  | { ok: false; reason: string; retryAfterSec?: number };

export type ServedAd = {
  impressionId: string;
  token: string;
  expiresAt: number;
  adId: string;
  headline: string;
  body: string;
  imageUrl: string | null;
  ctaText: string;
  accent: string;
  advertiser: string;
  category: string;
};

/** Dayparting: {"tz":"Asia/Kolkata","hours":[9,...,18],"days":[1,2,3,4,5]} */
function withinSchedule(dayparting: string | null, now: Date): boolean {
  if (!dayparting) return true;
  try {
    const rule = JSON.parse(dayparting) as { tz?: string; hours?: number[]; days?: number[] };
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: rule.tz || 'UTC', hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    if (rule.hours?.length && !rule.hours.includes(hour)) return false;
    if (rule.days?.length && !rule.days.includes(day)) return false;
    return true;
  } catch {
    return true;
  }
}

/** Expected revenue per thousand impressions, used to rank competing campaigns. */
function effectiveCpm(c: {
  pricingModel: string; cpmMicros: bigint; cpcMicros: bigint;
  ads: { impressionCount: number; clickCount: number }[];
}): number {
  const imps = c.ads.reduce((a, b) => a + b.impressionCount, 0);
  const clicks = c.ads.reduce((a, b) => a + b.clickCount, 0);
  // Smoothed CTR: assume a 1.5% prior until a campaign has real history.
  const ctr = (clicks + 1.5) / (imps + 100);
  const cpm = Number(c.cpmMicros);
  const cpc = Number(c.cpcMicros);
  if (c.pricingModel === 'CPM') return cpm;
  if (c.pricingModel === 'CPC') return cpc * ctr * 1000;
  return cpm + cpc * ctr * 1000;
}

function weightedPick<T>(items: T[], weight: (t: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  const total = items.reduce((a, b) => a + Math.max(weight(b), 0.0001), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= Math.max(weight(it), 0.0001);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

type Candidate = Awaited<ReturnType<typeof loadCandidates>>[number];

/**
 * The eligible-campaign query is identical for every ad request, so it is held
 * briefly in process rather than re-run per impression. Over-delivery in that
 * window is bounded by the billing layer, which never spends past the wallet or
 * the remaining budget.
 */
const POOL_TTL_MS = 10_000;
let poolCache: { at: number; rows: Candidate[] } | null = null;

async function loadCandidates(now: Date) {
  return prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      startAt: { lte: now },
      endAt: { gte: now },
      vendor: { status: 'ACTIVE', balanceMicros: { gt: 0 } },
      ads: { some: { status: 'ACTIVE' } },
    },
    include: {
      geoRules: true,
      // A creative whose destination failed review must never be served.
      // Written as an explicit OR because `urlVerdict <> 'BLOCKED'` is NULL-
      // unsafe: a creative that has not been scanned yet has a NULL verdict.
      ads: { where: { status: 'ACTIVE', OR: [{ urlVerdict: null }, { urlVerdict: { not: 'BLOCKED' } }] } },
      vendor: { select: { id: true, companyName: true, balanceMicros: true } },
    },
  });
}

async function candidatePool(now: Date): Promise<Candidate[]> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.rows;
  const rows = await loadCandidates(now);
  poolCache = { at: Date.now(), rows };
  return rows;
}

/** Called when a campaign's state changes, so the next serve sees it. */
export function invalidateCandidatePool() {
  poolCache = null;
}

// Delivery counters live in the cache: they are read on every ad request and a
// few seconds of drift costs nothing, where a COUNT per request costs a lot.
const hourKey = (publisherId: string) => `serve:hr:${publisherId}:${Math.floor(Date.now() / 3_600_000)}`;
const dayKey = (publisherId: string, campaignId: string) => `serve:day:${publisherId}:${campaignId}:${platformDayKey()}`;

export async function selectAd(ctx: ServeContext): Promise<ServeResult> {
  if (!(await getBool('global_ads_enabled'))) return { ok: false, reason: 'ads_disabled_globally' };

  const publisher = await prisma.publisher.findUnique({ where: { id: ctx.publisherId } });
  if (!publisher) return { ok: false, reason: 'unknown_publisher' };
  if (!publisher.adsEnabled) return { ok: false, reason: 'user_opted_out' };

  const now = new Date();

  // --- per-user pacing ------------------------------------------------
  // Pacing is platform policy. A publisher row may carry an admin-set
  // override; null means inherit whatever the super admin configured.
  const [policyGap, policyCap] = await Promise.all([
    getNumber('min_seconds_between_ads'),
    getNumber('max_ads_per_hour'),
  ]);
  const minGapSec = publisher.minSecondsBetweenAds ?? policyGap;
  const maxPerHour = publisher.maxAdsPerHour ?? policyCap;

  const last = await prisma.impression.findFirst({
    where: { publisherId: publisher.id },
    orderBy: { servedAt: 'desc' },
    select: { servedAt: true, adId: true },
  });
  if (last) {
    const gapSec = (now.getTime() - last.servedAt.getTime()) / 1000;
    if (gapSec < minGapSec) {
      return { ok: false, reason: 'cooldown', retryAfterSec: Math.ceil(minGapSec - gapSec) };
    }
  }
  const servedLastHour = Number((await cache.get(hourKey(publisher.id))) ?? 0);
  if (servedLastHour >= maxPerHour) {
    return { ok: false, reason: 'hourly_cap_reached', retryAfterSec: 600 };
  }

  // --- candidate pool -------------------------------------------------
  const candidates = await candidatePool(now);
  if (candidates.length === 0) return { ok: false, reason: 'no_campaigns' };

  const today = platformDayKey(now);
  const blocked = publisher.blockedCategories.split(',').map((s) => s.trim()).filter(Boolean);

  // Frequency caps are read from counters, and only for campaigns that survive
  // the cheap filters — so a request touches at most a handful of keys.
  const eligible: Candidate[] = [];
  for (const c of candidates) {
    if (c.totalBudgetMicros > 0n && c.spentMicros >= c.totalBudgetMicros) continue;
    // Daily pacing now reads a column maintained at charge time; the auction
    // used to run two aggregates per candidate, per request.
    const spentToday = c.spentTodayDate === today ? c.spentTodayMicros : 0n;
    if (c.dailyBudgetMicros > 0n && spentToday >= c.dailyBudgetMicros) continue;
    if (c.ads.length === 0) continue; // every creative pulled or blocked
    if (!withinSchedule(c.dayparting, now)) continue;
    if (!geoMatches(c.geoRules, ctx.geo)) continue;
    if (blocked.includes(c.category)) continue;
    eligible.push(c);
  }
  if (eligible.length === 0) return { ok: false, reason: 'no_eligible_campaign' };

  const capped: Candidate[] = [];
  for (const c of eligible) {
    if (c.frequencyCapPerDay <= 0) { capped.push(c); continue; }
    const seen = Number((await cache.get(dayKey(publisher.id, c.id))) ?? 0);
    if (seen < c.frequencyCapPerDay) capped.push(c);
  }
  if (capped.length === 0) return { ok: false, reason: 'frequency_capped' };

  // --- auction --------------------------------------------------------
  const scored = capped.map((c) => {
    const specificity = geoSpecificity(c.geoRules, ctx.geo); // local targeting outbids global
    const score = effectiveCpm(c) * (1 + specificity * 0.05) * (0.7 + c.priority * 0.06);
    return { campaign: c, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Rotate among the strongest few rather than always serving the top bid —
  // this is what makes a different ad appear on each new "thinking" moment.
  const pool = scored.slice(0, Math.min(4, scored.length));
  const chosen = weightedPick(pool, (p) => p.score)?.campaign;
  if (!chosen) return { ok: false, reason: 'no_eligible_campaign' };

  let creatives = chosen.ads;
  const avoid = ctx.excludeAdId ?? last?.adId;
  if (avoid && creatives.length > 1) creatives = creatives.filter((a) => a.id !== avoid);
  const creative = weightedPick(creatives, (a) => a.weight);
  if (!creative) return { ok: false, reason: 'no_creative' };

  // --- book the impression as SERVED (unbilled until confirmed) --------
  const risk = await scoreServe({ publisherId: publisher.id, deviceId: ctx.deviceId, ipHash: hashIp(ctx.ip) });

  const impression = await prisma.impression.create({
    data: {
      adId: creative.id,
      campaignId: chosen.id,
      vendorId: chosen.vendorId,
      publisherId: publisher.id,
      deviceId: ctx.deviceId,
      status: 'SERVED',
      country: ctx.geo.country, state: ctx.geo.state, city: ctx.geo.city, area: ctx.geo.area,
      ipHash: hashIp(ctx.ip),
      hostApp: ctx.hostApp,
      modelHint: ctx.modelHint,
      riskScore: risk.score,
      flagged: risk.flagged,
    },
  });

  await Promise.all([
    cache.incr(hourKey(publisher.id), 3_900),
    chosen.frequencyCapPerDay > 0 ? cache.incr(dayKey(publisher.id, chosen.id), 90_000) : Promise.resolve(0),
  ]);

  const expiresAt = Date.now() + IMPRESSION_TTL_MS;
  return {
    ok: true,
    ad: {
      impressionId: impression.id,
      token: signImpression(impression.id, expiresAt),
      expiresAt,
      adId: creative.id,
      headline: creative.headline,
      body: creative.body,
      imageUrl: creative.imageUrl,
      ctaText: creative.ctaText,
      accent: creative.accent,
      advertiser: chosen.vendor.companyName,
      category: chosen.category,
    },
  };
}
