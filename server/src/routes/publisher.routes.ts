/** End-user API: earnings, devices, payout requests, ad preferences. */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, paging, wrap } from '../lib/http.js';
import { requireAuth, requirePublisher, requireRole } from '../middleware/auth.js';
import { writeLimiter, paymentLimiter } from '../middleware/rateLimit.js';
import { sha256 } from '../lib/crypto.js';
import { usdToMicros } from '../lib/money.js';
import { AD_CATEGORIES } from '../lib/constants.js';
import { getBigInt, getNumber } from '../services/settings.js';
import { hostBreakdown, parseRange, timeSeries, totals } from '../services/stats.js';
import { audit } from '../lib/audit.js';

export const publisherRouter = Router();
publisherRouter.use(requireAuth, requireRole('END_USER'), requirePublisher);

const pid = (req: { user?: { publisherId?: string } }) => req.user!.publisherId!;

// Ambiguous characters removed so codes are easy to read off a screen.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () =>
  Array.from(crypto.randomBytes(8)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

publisherRouter.get('/overview', wrap(async (req, res) => {
  const range = parseRange(req.query);
  const publisherId = pid(req);

  const [publisher, agg, series, hosts, devices, recent, minPayout, shareBps, policyGap, policyCap] = await Promise.all([
    prisma.publisher.findUnique({ where: { id: publisherId } }),
    totals(range, { publisherId }),
    timeSeries(range, { publisherId }),
    hostBreakdown(range, { publisherId }),
    prisma.device.findMany({ where: { publisherId, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.impression.findMany({
      where: { publisherId, status: { in: ['VIEWED', 'CLICKED'] } },
      orderBy: { servedAt: 'desc' },
      take: 15,
      select: {
        id: true, servedAt: true, status: true, payoutMicros: true, hostApp: true,
        ad: { select: { headline: true } },
        campaign: { select: { category: true } },
      },
    }),
    getBigInt('min_payout_micros'),
    getNumber('publisher_share_bps'),
    getNumber('min_seconds_between_ads'),
    getNumber('max_ads_per_hour'),
  ]);

  res.json({
    publisher,
    totals: agg,
    series,
    hosts,
    devices: devices.map((d) => ({ ...d, pending: d.lastSeenAt === null })),
    recent,
    minPayoutMicros: minPayout,
    revenueSharePct: shareBps / 100,
    // Read-only: set by the platform, with an optional per-account override.
    pacing: {
      maxAdsPerHour: publisher?.maxAdsPerHour ?? policyCap,
      minSecondsBetweenAds: publisher?.minSecondsBetweenAds ?? policyGap,
      isOverride: publisher?.maxAdsPerHour !== null || publisher?.minSecondsBetweenAds !== null,
    },
  });
}));

publisherRouter.get('/earnings', wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = { publisherId: pid(req), account: 'PUBLISHER' as const };
  const [rows, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: {
        impression: {
          select: { hostApp: true, country: true, city: true, status: true, ad: { select: { headline: true } } },
        },
      },
    }),
    prisma.ledgerEntry.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

// ----------------------------------------------------------------- devices

publisherRouter.get('/devices', wrap(async (req, res) => {
  const devices = await prisma.device.findMany({
    where: { publisherId: pid(req) },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { impressions: true } } },
  });
  res.json(devices.map((d) => ({ ...d, pending: d.lastSeenAt === null })));
}));

/** Generates a 15-minute code the browser extension exchanges for a device key. */
publisherRouter.post('/devices/pair-code', writeLimiter, wrap(async (req, res) => {
  const { label } = z.object({ label: z.string().max(60).default('My computer') }).parse(req.body ?? {});
  const publisherId = pid(req);

  const active = await prisma.device.count({ where: { publisherId, revokedAt: null } });
  if (active >= 10) throw ApiError.badRequest('Device limit reached — revoke an old device first');

  // Clean up codes that were never claimed.
  await prisma.device.deleteMany({
    where: { publisherId, lastSeenAt: null, createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
  });

  const code = makeCode();
  const device = await prisma.device.create({
    data: { publisherId, keyHash: sha256(`pairing:${code}`), label: `Pending — ${label}` },
  });

  res.status(201).json({ code, deviceId: device.id, expiresAt: Date.now() + 15 * 60_000 });
}));

publisherRouter.delete('/devices/:id', wrap(async (req, res) => {
  const device = await prisma.device.findFirst({ where: { id: req.params.id, publisherId: pid(req) } });
  if (!device) throw ApiError.notFound('Device not found');
  await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
  await audit({ actorId: req.user!.id, actorRole: 'END_USER', action: 'device.revoked', entity: 'Device', entityId: device.id });
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- settings

publisherRouter.patch('/settings', writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    displayName: z.string().min(2).max(80).optional(),
    adsEnabled: z.boolean().optional(),
    blockedCategories: z.array(z.enum(AD_CATEGORIES)).optional(),
    payoutMethod: z.enum(['PAYPAL', 'BANK', 'UPI', 'CRYPTO']).optional(),
    payoutDetails: z.record(z.string()).optional(),
  }).parse(req.body);

  const publisher = await prisma.publisher.update({
    where: { id: pid(req) },
    data: {
      ...(body.displayName && { displayName: body.displayName }),
      ...(body.adsEnabled !== undefined && { adsEnabled: body.adsEnabled }),
      ...(body.blockedCategories && { blockedCategories: body.blockedCategories.join(',') }),
      ...(body.payoutMethod && { payoutMethod: body.payoutMethod }),
      ...(body.payoutDetails && { payoutDetails: JSON.stringify(body.payoutDetails) }),
    },
  });
  res.json(publisher);
}));

// ----------------------------------------------------------------- payouts

publisherRouter.get('/payouts', wrap(async (req, res) => {
  const [payouts, publisher, minPayout] = await Promise.all([
    prisma.payout.findMany({ where: { publisherId: pid(req) }, orderBy: { requestedAt: 'desc' } }),
    prisma.publisher.findUnique({ where: { id: pid(req) } }),
    getBigInt('min_payout_micros'),
  ]);
  res.json({ payouts, balanceMicros: publisher?.balanceMicros ?? 0n, minPayoutMicros: minPayout });
}));

publisherRouter.post('/payouts', paymentLimiter, wrap(async (req, res) => {
  const body = z.object({ amountUsd: z.number().min(0.01) }).parse(req.body);
  const amount = usdToMicros(body.amountUsd);

  const publisher = await prisma.publisher.findUnique({ where: { id: pid(req) } });
  if (!publisher) throw ApiError.notFound('Profile not found');
  if (!publisher.payoutMethod) throw ApiError.badRequest('Add a payout method before withdrawing');

  const minPayout = await getBigInt('min_payout_micros');
  if (amount < minPayout) throw ApiError.badRequest(`Minimum withdrawal is $${Number(minPayout) / 1e6}`);

  // Money already committed to an open request cannot be requested twice.
  const openAgg = await prisma.payout.aggregate({
    _sum: { amountMicros: true },
    where: { publisherId: publisher.id, status: { in: ['REQUESTED', 'APPROVED'] } },
  });
  const available = publisher.balanceMicros - (openAgg._sum.amountMicros ?? 0n);
  if (amount > available) throw ApiError.badRequest('Amount exceeds your available balance');

  const payout = await prisma.payout.create({
    data: {
      publisherId: publisher.id,
      amountMicros: amount,
      method: publisher.payoutMethod,
      details: publisher.payoutDetails ?? '',
    },
  });
  await audit({ actorId: req.user!.id, actorRole: 'END_USER', action: 'payout.requested', entity: 'Payout', entityId: payout.id, meta: { amountUsd: body.amountUsd } });
  res.status(201).json(payout);
}));

publisherRouter.delete('/payouts/:id', wrap(async (req, res) => {
  const payout = await prisma.payout.findFirst({ where: { id: req.params.id, publisherId: pid(req) } });
  if (!payout) throw ApiError.notFound('Payout not found');
  if (payout.status !== 'REQUESTED') throw ApiError.badRequest('Only a pending request can be cancelled');
  await prisma.payout.update({ where: { id: payout.id }, data: { status: 'REJECTED', note: 'cancelled by user' } });
  res.json({ ok: true });
}));
