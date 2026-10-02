import { prisma } from '../lib/prisma.js';
import { dayKeyIn, resolveTimeZone } from '../lib/time.js';

export type Range = { from: Date; to: Date; days: number; timeZone: string };

/**
 * `tz` comes from the viewer, so an advertiser in Asia/Kolkata sees their own
 * days rather than UTC ones. Bucketing on UTC shifted every Indian day by 5½
 * hours, which made the panel disagree with the advertiser's own reporting.
 */
export function parseRange(q: Record<string, unknown>): Range {
  const days = Math.min(Math.max(Number(q.days ?? 30) || 30, 1), 365);
  const to = q.to ? new Date(String(q.to)) : new Date();
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - days * 86_400_000);
  return {
    from, to,
    days: Math.ceil((to.getTime() - from.getTime()) / 86_400_000) || 1,
    timeZone: resolveTimeZone(q.tz ? String(q.tz) : null),
  };
}

/** Buckets are built in JS so they can honour an arbitrary IANA timezone. */
export async function timeSeries(range: Range, where: { vendorId?: string; publisherId?: string; campaignId?: string } = {}) {
  const dayKey = (d: Date) => dayKeyIn(d, range.timeZone);
  const impressions = await prisma.impression.findMany({
    where: {
      ...where,
      servedAt: { gte: range.from, lte: range.to },
      status: { in: ['VIEWED', 'CLICKED'] },
    },
    select: { servedAt: true, costMicros: true, payoutMicros: true, platformMicros: true, status: true },
  });
  const clicks = await prisma.click.findMany({
    where: {
      clickedAt: { gte: range.from, lte: range.to },
      impression: { ...where },
    },
    select: { clickedAt: true, costMicros: true, payoutMicros: true, platformMicros: true },
  });

  const buckets = new Map<string, { date: string; impressions: number; clicks: number; spendMicros: bigint; payoutMicros: bigint; platformMicros: bigint }>();
  const touch = (d: Date) => {
    const k = dayKey(d);
    if (!buckets.has(k)) {
      buckets.set(k, { date: k, impressions: 0, clicks: 0, spendMicros: 0n, payoutMicros: 0n, platformMicros: 0n });
    }
    return buckets.get(k)!;
  };

  // Pre-seed every day so the chart has no holes.
  for (let t = range.from.getTime(); t <= range.to.getTime(); t += 86_400_000) touch(new Date(t));

  for (const i of impressions) {
    const b = touch(i.servedAt);
    b.impressions += 1;
    b.spendMicros += i.costMicros;
    b.payoutMicros += i.payoutMicros;
    b.platformMicros += i.platformMicros;
  }
  for (const c of clicks) {
    const b = touch(c.clickedAt);
    b.clicks += 1;
    b.spendMicros += c.costMicros;
    b.payoutMicros += c.payoutMicros;
    b.platformMicros += c.platformMicros;
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function totals(range: Range, where: { vendorId?: string; publisherId?: string } = {}) {
  const [impAgg, impCount, clickAgg, clickCount] = await Promise.all([
    prisma.impression.aggregate({
      _sum: { costMicros: true, payoutMicros: true, platformMicros: true },
      where: { ...where, servedAt: { gte: range.from, lte: range.to }, status: { in: ['VIEWED', 'CLICKED'] } },
    }),
    prisma.impression.count({
      where: { ...where, servedAt: { gte: range.from, lte: range.to }, status: { in: ['VIEWED', 'CLICKED'] } },
    }),
    prisma.click.aggregate({
      _sum: { costMicros: true, payoutMicros: true, platformMicros: true },
      where: { clickedAt: { gte: range.from, lte: range.to }, impression: { ...where } },
    }),
    prisma.click.count({ where: { clickedAt: { gte: range.from, lte: range.to }, impression: { ...where } } }),
  ]);

  const spend = (impAgg._sum.costMicros ?? 0n) + (clickAgg._sum.costMicros ?? 0n);
  const payout = (impAgg._sum.payoutMicros ?? 0n) + (clickAgg._sum.payoutMicros ?? 0n);
  const platform = (impAgg._sum.platformMicros ?? 0n) + (clickAgg._sum.platformMicros ?? 0n);

  return {
    impressions: impCount,
    clicks: clickCount,
    ctr: impCount ? clickCount / impCount : 0,
    spendMicros: spend,
    payoutMicros: payout,
    platformMicros: platform,
    ecpmMicros: impCount ? (spend * 1000n) / BigInt(impCount) : 0n,
    ecpcMicros: clickCount ? spend / BigInt(clickCount) : 0n,
  };
}

/** Where impressions landed. Vendors see this aggregated; never per user. */
export async function geoBreakdown(range: Range, where: { vendorId?: string } = {}, level: 'country' | 'state' | 'city' | 'area' = 'city') {
  const rows = await prisma.impression.groupBy({
    by: ['country', 'state', 'city', 'area'],
    where: { ...where, servedAt: { gte: range.from, lte: range.to }, status: { in: ['VIEWED', 'CLICKED'] } },
    _count: { _all: true },
    _sum: { costMicros: true, payoutMicros: true },
  });

  const keyOf = (r: (typeof rows)[number]) => {
    if (level === 'country') return r.country;
    if (level === 'state') return [r.country, r.state].filter(Boolean).join(' / ');
    if (level === 'city') return [r.country, r.state, r.city].filter(Boolean).join(' / ');
    return [r.country, r.state, r.city, r.area].filter(Boolean).join(' / ');
  };

  const agg = new Map<string, { key: string; country: string; state: string; city: string; area: string; impressions: number; spendMicros: bigint }>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = agg.get(k) ?? { key: k, country: r.country, state: r.state, city: r.city, area: r.area, impressions: 0, spendMicros: 0n };
    cur.impressions += r._count._all;
    cur.spendMicros += r._sum.costMicros ?? 0n;
    agg.set(k, cur);
  }

  const clicks = await prisma.click.findMany({
    where: { clickedAt: { gte: range.from, lte: range.to }, impression: { ...where } },
    select: { impression: { select: { country: true, state: true, city: true, area: true } } },
  });
  const clickCounts = new Map<string, number>();
  for (const c of clicks) {
    const k = keyOf(c.impression as never);
    clickCounts.set(k, (clickCounts.get(k) ?? 0) + 1);
  }

  return [...agg.values()]
    .map((r) => ({ ...r, clicks: clickCounts.get(r.key) ?? 0 }))
    .sort((a, b) => b.impressions - a.impressions);
}

export async function topCampaigns(range: Range, where: { vendorId?: string } = {}, take = 10) {
  const rows = await prisma.impression.groupBy({
    by: ['campaignId'],
    where: { ...where, servedAt: { gte: range.from, lte: range.to }, status: { in: ['VIEWED', 'CLICKED'] } },
    _count: { _all: true },
    _sum: { costMicros: true },
    orderBy: { _sum: { costMicros: 'desc' } },
    take,
  });
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: rows.map((r) => r.campaignId) } },
    include: { vendor: { select: { companyName: true } } },
  });
  const byId = new Map(campaigns.map((c) => [c.id, c]));

  const clickRows = await prisma.click.findMany({
    where: { clickedAt: { gte: range.from, lte: range.to }, impression: { ...where, campaignId: { in: rows.map((r) => r.campaignId) } } },
    select: { impression: { select: { campaignId: true } } },
  });
  const clicksBy = new Map<string, number>();
  for (const c of clickRows) {
    const id = c.impression.campaignId;
    clicksBy.set(id, (clicksBy.get(id) ?? 0) + 1);
  }

  return rows.map((r) => {
    const c = byId.get(r.campaignId);
    const clicks = clicksBy.get(r.campaignId) ?? 0;
    return {
      campaignId: r.campaignId,
      name: c?.name ?? 'Removed campaign',
      vendor: c?.vendor.companyName ?? '—',
      status: c?.status ?? 'UNKNOWN',
      impressions: r._count._all,
      clicks,
      ctr: r._count._all ? clicks / r._count._all : 0,
      spendMicros: r._sum.costMicros ?? 0n,
    };
  });
}

/** Which AI surfaces the ads were shown on. */
export async function hostBreakdown(range: Range, where: { vendorId?: string; publisherId?: string } = {}) {
  const rows = await prisma.impression.groupBy({
    by: ['hostApp'],
    where: { ...where, servedAt: { gte: range.from, lte: range.to }, status: { in: ['VIEWED', 'CLICKED'] } },
    _count: { _all: true },
    _sum: { costMicros: true, payoutMicros: true },
  });
  return rows
    .map((r) => ({ hostApp: r.hostApp, impressions: r._count._all, spendMicros: r._sum.costMicros ?? 0n, payoutMicros: r._sum.payoutMicros ?? 0n }))
    .sort((a, b) => b.impressions - a.impressions);
}
