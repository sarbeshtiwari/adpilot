/** Super-admin API. Unscoped: sees every vendor, every end user, every dollar. */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, paging, wrap } from '../lib/http.js';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { runAutoPayouts } from '../services/payouts.js';
import { issueInvoiceForRecharge, buildTaxDocument } from '../services/invoicing.js';
import { eraseUser } from '../services/privacy.js';
import { rescanCreatives } from '../services/urlSafety.js';
import { decayRiskScores } from '../services/fraud.js';
import { sendMail, templates } from '../services/mail.js';
import { invalidateCandidatePool } from '../services/adserve.js';
import { env } from '../env.js';
import { razorpayEnabled, razorpayXEnabled } from '../services/razorpay.js';
import { usdToMicros } from '../lib/money.js';
import { adjust, creditVendor, debitPublisherForPayout } from '../services/billing.js';
import { allSettings, getNumber, setSetting, SETTING_DEFAULTS } from '../services/settings.js';
import { geoBreakdown, hostBreakdown, parseRange, timeSeries, topCampaigns, totals } from '../services/stats.js';
import { audit } from '../lib/audit.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('SUPER_ADMIN'));

const bootedAt = Date.now();

// ----------------------------------------------------------------- overview

adminRouter.get('/overview', requirePermission('dashboard', 'read'), wrap(async (req, res) => {
  const range = parseRange(req.query);

  const [agg, series, top, geo, hosts, counts, walletAgg, pubAgg, pending] = await Promise.all([
    totals(range),
    timeSeries(range),
    topCampaigns(range, {}, 8),
    geoBreakdown(range, {}, 'city'),
    hostBreakdown(range),
    Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      prisma.publisher.count(),
      prisma.device.count({ where: { revokedAt: null, lastSeenAt: { not: null } } }),
      prisma.campaign.count({ where: { status: 'ACTIVE' } }),
      prisma.ad.count({ where: { status: 'ACTIVE' } }),
    ]),
    prisma.vendor.aggregate({ _sum: { balanceMicros: true, lifetimeSpendMicros: true, lifetimeTopUpMicros: true } }),
    prisma.publisher.aggregate({ _sum: { balanceMicros: true, lifetimeEarnedMicros: true, paidOutMicros: true } }),
    Promise.all([
      prisma.campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.vendor.count({ where: { status: 'PENDING' } }),
      prisma.payout.count({ where: { status: { in: ['REQUESTED', 'APPROVED'] } } }),
      prisma.recharge.count({ where: { status: 'PENDING' } }),
    ]),
  ]);

  const [vendors, activeVendors, publishers, activeDevices, activeCampaigns, activeAds] = counts;
  const [pendingCampaigns, pendingVendors, pendingPayouts, pendingRecharges] = pending;

  res.json({
    totals: agg,
    series,
    topCampaigns: top,
    geo: geo.slice(0, 15),
    hosts,
    counts: { vendors, activeVendors, publishers, activeDevices, activeCampaigns, activeAds },
    money: {
      vendorFloatMicros: walletAgg._sum.balanceMicros ?? 0n,        // unspent vendor deposits we hold
      lifetimeSpendMicros: walletAgg._sum.lifetimeSpendMicros ?? 0n,
      lifetimeTopUpMicros: walletAgg._sum.lifetimeTopUpMicros ?? 0n,
      publisherOwedMicros: pubAgg._sum.balanceMicros ?? 0n,          // earned but not yet withdrawn
      publisherEarnedMicros: pubAgg._sum.lifetimeEarnedMicros ?? 0n,
      publisherPaidMicros: pubAgg._sum.paidOutMicros ?? 0n,
    },
    queue: { pendingCampaigns, pendingVendors, pendingPayouts, pendingRecharges },
    uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
  });
}));

adminRouter.get('/health', requirePermission('health', 'read'), wrap(async (_req, res) => {
  const t0 = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const dbLatencyMs = Date.now() - t0;

  const hourAgo = new Date(Date.now() - 3600_000);
  const [servedLastHour, viewedLastHour, clickedLastHour, voidedLastHour, lastImpression, lowBalanceVendors, staleDevices] =
    await Promise.all([
      prisma.impression.count({ where: { servedAt: { gte: hourAgo } } }),
      prisma.impression.count({ where: { servedAt: { gte: hourAgo }, status: { in: ['VIEWED', 'CLICKED'] } } }),
      prisma.click.count({ where: { clickedAt: { gte: hourAgo } } }),
      prisma.impression.count({ where: { servedAt: { gte: hourAgo }, status: 'VOID' } }),
      prisma.impression.findFirst({ orderBy: { servedAt: 'desc' }, select: { servedAt: true } }),
      prisma.vendor.count({ where: { status: 'ACTIVE', balanceMicros: { lt: 1_000_000 } } }),
      prisma.device.count({ where: { revokedAt: null, lastSeenAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } }),
    ]);

  const mem = process.memoryUsage();
  res.json({
    status: dbLatencyMs < 500 ? 'healthy' : 'degraded',
    dbLatencyMs,
    uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
    memoryMb: { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) },
    nodeVersion: process.version,
    lastHour: {
      served: servedLastHour,
      confirmed: viewedLastHour,
      clicked: clickedLastHour,
      voided: voidedLastHour,
      confirmRate: servedLastHour ? viewedLastHour / servedLastHour : 0,
      ctr: viewedLastHour ? clickedLastHour / viewedLastHour : 0,
    },
    lastImpressionAt: lastImpression?.servedAt ?? null,
    warnings: [
      ...(lowBalanceVendors ? [`${lowBalanceVendors} active vendor(s) below $1.00 balance`] : []),
      ...(staleDevices ? [`${staleDevices} device(s) not seen in 7 days`] : []),
      ...(dbLatencyMs >= 500 ? ['Database latency above 500ms'] : []),
    ],
  });
}));

// ----------------------------------------------------------------- vendors

adminRouter.get('/vendors', requirePermission('vendors', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const q = req.query.q ? String(req.query.q) : undefined;
  const where = {
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(q ? { OR: [{ companyName: { contains: q, mode: 'insensitive' as const } }, { user: { email: { contains: q, mode: 'insensitive' as const } } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.vendor.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true, status: true, lastLoginAt: true } },
        _count: { select: { campaigns: true } },
      },
    }),
    prisma.vendor.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.get('/vendors/:id', requirePermission('vendors', 'read'), wrap(async (req, res) => {
  const range = parseRange(req.query);
  const vendor = await prisma.vendor.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, email: true, name: true, status: true, createdAt: true, lastLoginAt: true } },
      campaigns: { include: { ads: true, geoRules: true }, orderBy: { createdAt: 'desc' } },
      recharges: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  if (!vendor) throw ApiError.notFound('Vendor not found');

  const [agg, series, geo, ledger] = await Promise.all([
    totals(range, { vendorId: vendor.id }),
    timeSeries(range, { vendorId: vendor.id }),
    geoBreakdown(range, { vendorId: vendor.id }, 'city'),
    prisma.ledgerEntry.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  res.json({ vendor, totals: agg, series, geo, ledger });
}));

adminRouter.patch('/vendors/:id', requirePermission('vendors', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).optional(),
    notes: z.string().max(2000).optional(),
  }).parse(req.body);

  const vendor = await prisma.vendor.update({ where: { id: req.params.id }, data: body });

  // Suspending a vendor must stop delivery immediately.
  if (body.status === 'SUSPENDED') {
    await prisma.campaign.updateMany({ where: { vendorId: vendor.id, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
  }
  invalidateCandidatePool();

  if (body.status === 'ACTIVE' || body.status === 'SUSPENDED') {
    const owner = await prisma.user.findUnique({ where: { id: vendor.userId }, select: { email: true } });
    if (owner) {
      const mail = body.status === 'ACTIVE'
        ? templates.vendorApproved(vendor.companyName, `${env.panelUrl}/vendor`)
        : templates.vendorRejected(vendor.companyName, body.notes ?? '');
      await sendMail(owner.email, body.status === 'ACTIVE' ? 'vendorApproved' : 'vendorRejected', mail, { vendorId: vendor.id });
    }
  }
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'vendor.updated', entity: 'Vendor', entityId: vendor.id, meta: body });
  res.json(vendor);
}));

adminRouter.post('/vendors/:id/credit', requirePermission('vendors', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    amountUsd: z.number(),
    note: z.string().min(3).max(200),
  }).parse(req.body);

  const entry = body.amountUsd >= 0
    ? await creditVendor(req.params.id, usdToMicros(body.amountUsd), body.note, req.user!.id)
    : await adjust({ account: 'VENDOR', vendorId: req.params.id, amountMicros: usdToMicros(body.amountUsd), note: body.note, actorId: req.user!.id });

  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'vendor.credit', entity: 'Vendor', entityId: req.params.id, meta: body });
  res.json(entry);
}));

// ----------------------------------------------------------------- end users

adminRouter.get('/publishers', requirePermission('endusers', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const q = req.query.q ? String(req.query.q) : undefined;
  const where = q
    ? { OR: [{ displayName: { contains: q, mode: 'insensitive' as const } }, { user: { email: { contains: q, mode: 'insensitive' as const } } }, { city: { contains: q, mode: 'insensitive' as const } }] }
    : {};
  const [rows, total] = await Promise.all([
    prisma.publisher.findMany({
      where, take, skip, orderBy: { lifetimeEarnedMicros: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true, status: true, lastLoginAt: true, createdAt: true } },
        _count: { select: { devices: true, impressions: true } },
      },
    }),
    prisma.publisher.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.get('/publishers/:id', requirePermission('endusers', 'read'), wrap(async (req, res) => {
  const range = parseRange(req.query);
  const publisher = await prisma.publisher.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, email: true, name: true, status: true, createdAt: true, lastLoginAt: true } },
      devices: { orderBy: { createdAt: 'desc' } },
      payouts: { orderBy: { requestedAt: 'desc' } },
    },
  });
  if (!publisher) throw ApiError.notFound('End user not found');

  const [agg, series, hosts, ledger, impressions, policyGap, policyCap] = await Promise.all([
    totals(range, { publisherId: publisher.id }),
    timeSeries(range, { publisherId: publisher.id }),
    hostBreakdown(range, { publisherId: publisher.id }),
    prisma.ledgerEntry.findMany({ where: { publisherId: publisher.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.impression.findMany({
      where: { publisherId: publisher.id },
      orderBy: { servedAt: 'desc' }, take: 50,
      include: { ad: { select: { headline: true } }, campaign: { select: { name: true, vendor: { select: { companyName: true } } } } },
    }),
    getNumber('min_seconds_between_ads'),
    getNumber('max_ads_per_hour'),
  ]);
  res.json({
    publisher, totals: agg, series, hosts, ledger, impressions,
    policy: { maxAdsPerHour: policyCap, minSecondsBetweenAds: policyGap },
  });
}));

/** Per-account delivery pacing. Only a super admin can touch this. */
adminRouter.patch('/publishers/:id/pacing', requirePermission('endusers', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    maxAdsPerHour: z.number().int().min(1).max(240).nullable(),
    minSecondsBetweenAds: z.number().int().min(5).max(3600).nullable(),
    adsEnabled: z.boolean().optional(),
  }).parse(req.body);

  const publisher = await prisma.publisher.update({
    where: { id: req.params.id },
    data: {
      maxAdsPerHour: body.maxAdsPerHour,
      minSecondsBetweenAds: body.minSecondsBetweenAds,
      ...(body.adsEnabled !== undefined && { adsEnabled: body.adsEnabled }),
    },
  });
  await audit({
    actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'publisher.pacing_updated',
    entity: 'Publisher', entityId: publisher.id, meta: body,
  });
  res.json(publisher);
}));

adminRouter.post('/publishers/:id/adjust', requirePermission('endusers', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({ amountUsd: z.number(), note: z.string().min(3).max(200) }).parse(req.body);
  const entry = await adjust({
    account: 'PUBLISHER', publisherId: req.params.id,
    amountMicros: usdToMicros(body.amountUsd), note: body.note, actorId: req.user!.id,
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'publisher.adjust', entity: 'Publisher', entityId: req.params.id, meta: body });
  res.json(entry);
}));

// ----------------------------------------------------------------- accounts

adminRouter.get('/users', requirePermission('team', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const q = req.query.q ? String(req.query.q) : undefined;
  const where = {
    ...(req.query.role ? { role: String(req.query.role) } : {}),
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, name: true, role: true, status: true, createdAt: true, lastLoginAt: true,
        vendor: { select: { id: true, companyName: true, balanceMicros: true, status: true } },
        publisher: { select: { id: true, balanceMicros: true, lifetimeEarnedMicros: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.patch('/users/:id', requirePermission('team', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING']).optional(),
    name: z.string().min(2).max(80).optional(),
  }).parse(req.body);

  if (req.params.id === req.user!.id && body.status && body.status !== 'ACTIVE') {
    throw ApiError.badRequest('You cannot suspend your own account');
  }
  const user = await prisma.user.update({ where: { id: req.params.id }, data: body });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'user.updated', entity: 'User', entityId: user.id, meta: body });
  res.json(user);
}));

adminRouter.post('/users/:id/reset-password', requirePermission('team', 'update'), writeLimiter, wrap(async (req, res) => {
  const { newPassword } = z.object({ newPassword: z.string().min(8) }).parse(req.body);
  await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'user.password_reset', entity: 'User', entityId: req.params.id });
  res.json({ ok: true });
}));

/** Create another super admin. */
adminRouter.post('/admins', requirePermission('team', 'create'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    email: z.string().email(), name: z.string().min(2), password: z.string().min(8),
  }).parse(req.body);
  const exists = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
  if (exists) throw ApiError.conflict('Email already registered');
  const user = await prisma.user.create({
    data: {
      email: body.email.toLowerCase(), name: body.name, role: 'SUPER_ADMIN',
      passwordHash: await bcrypt.hash(body.password, 10),
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'admin.created', entity: 'User', entityId: user.id });
  res.status(201).json(user);
}));

// ------------------------------------------------------------- moderation

adminRouter.get('/campaigns', requirePermission('campaigns', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = {
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.vendorId ? { vendorId: String(req.query.vendorId) } : {}),
    ...(req.query.q ? { name: { contains: String(req.query.q), mode: 'insensitive' as const } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.campaign.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: {
        vendor: { select: { id: true, companyName: true, balanceMicros: true, status: true } },
        ads: true, geoRules: true,
      },
    }),
    prisma.campaign.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.post('/campaigns/:id/review', requirePermission('campaigns', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    decision: z.enum(['APPROVE', 'REJECT', 'PAUSE']),
    note: z.string().max(500).default(''),
  }).parse(req.body);

  const status = body.decision === 'APPROVE' ? 'ACTIVE' : body.decision === 'REJECT' ? 'REJECTED' : 'PAUSED';
  const campaign = await prisma.campaign.update({
    where: { id: req.params.id },
    data: { status, reviewNote: body.note, reviewedAt: new Date() },
  });
  invalidateCandidatePool();
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: `campaign.${body.decision.toLowerCase()}`, entity: 'Campaign', entityId: campaign.id, meta: body });
  res.json(campaign);
}));

adminRouter.get('/ads', requirePermission('moderation', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const [rows, total] = await Promise.all([
    prisma.ad.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: { campaign: { select: { id: true, name: true, status: true, category: true, vendor: { select: { companyName: true } } } } },
    }),
    prisma.ad.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.post('/ads/:id/review', requirePermission('moderation', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).parse(req.body);
  const ad = await prisma.ad.update({
    where: { id: req.params.id },
    data: { status: body.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED' },
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: `ad.${body.decision.toLowerCase()}`, entity: 'Ad', entityId: ad.id });
  res.json(ad);
}));

// ----------------------------------------------------------------- money ops

adminRouter.get('/recharges', requirePermission('recharges', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const [rows, total] = await Promise.all([
    prisma.recharge.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: { vendor: { select: { id: true, companyName: true, balanceMicros: true } } },
    }),
    prisma.recharge.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.post('/recharges/:id/settle', requirePermission('recharges', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    decision: z.enum(['COMPLETE', 'FAIL']),
    reference: z.string().max(120).default(''),
    note: z.string().max(300).default(''),
  }).parse(req.body);

  const recharge = await prisma.recharge.findUnique({ where: { id: req.params.id } });
  if (!recharge) throw ApiError.notFound('Top-up not found');
  if (recharge.status !== 'PENDING') throw ApiError.conflict('Top-up already settled');

  if (body.decision === 'COMPLETE') {
    await creditVendor(recharge.vendorId, recharge.amountMicros, `top-up ${recharge.method} ${body.reference}`.trim(), req.user!.id);
  }
  const updated = await prisma.recharge.update({
    where: { id: recharge.id },
    data: {
      status: body.decision === 'COMPLETE' ? 'COMPLETED' : 'FAILED',
      settledAt: new Date(), approvedBy: req.user!.id,
      reference: body.reference || recharge.reference, note: body.note,
    },
  });
  if (body.decision === 'COMPLETE') await issueInvoiceForRecharge(recharge.id);
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: `recharge.${body.decision.toLowerCase()}`, entity: 'Recharge', entityId: recharge.id, meta: body });
  res.json(updated);
}));

adminRouter.get('/payouts', requirePermission('payouts', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const [rows, total, queued] = await Promise.all([
    prisma.payout.findMany({
      where, take, skip, orderBy: { requestedAt: 'desc' },
      include: {
        publisher: {
          select: {
            id: true, displayName: true, balanceMicros: true, country: true, city: true,
            user: { select: { email: true, name: true } },
          },
        },
      },
    }),
    prisma.payout.count({ where }),
    prisma.payout.aggregate({ _sum: { amountMicros: true }, where: { status: { in: ['REQUESTED', 'APPROVED'] } } }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows, queuedMicros: queued._sum.amountMicros ?? 0n });
}));

adminRouter.post('/payouts/:id/action', requirePermission('payouts', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    action: z.enum(['APPROVE', 'PAY', 'REJECT']),
    reference: z.string().max(120).default(''),
    note: z.string().max(300).default(''),
  }).parse(req.body);

  if (body.action === 'PAY') {
    const paid = await debitPublisherForPayout(req.params.id, req.user!.id);
    await prisma.payout.update({ where: { id: paid.id }, data: { reference: body.reference, note: body.note } });
    const earner = await prisma.publisher.findUnique({
      where: { id: paid.publisherId },
      select: { displayName: true, user: { select: { email: true } } },
    });
    if (earner) {
      await sendMail(earner.user.email, 'payoutPaid',
        templates.payoutPaid(earner.displayName, `$${(Number(paid.amountMicros) / 1e6).toFixed(2)}`, body.reference),
        { payoutId: paid.id });
    }
    await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'payout.paid', entity: 'Payout', entityId: paid.id, meta: body });
    return res.json(paid);
  }

  const payout = await prisma.payout.findUnique({ where: { id: req.params.id } });
  if (!payout) throw ApiError.notFound('Payout not found');
  if (payout.status === 'PAID') throw ApiError.conflict('Payout already settled');

  const updated = await prisma.payout.update({
    where: { id: payout.id },
    data: {
      status: body.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      processedBy: req.user!.id,
      ...(body.action === 'REJECT' ? { processedAt: new Date() } : {}),
      reference: body.reference, note: body.note,
    },
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: `payout.${body.action.toLowerCase()}`, entity: 'Payout', entityId: payout.id, meta: body });
  res.json(updated);
}));

adminRouter.get('/ledger', requirePermission('ledger', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req, 50);
  const where = {
    ...(req.query.type ? { type: String(req.query.type) } : {}),
    ...(req.query.account ? { account: String(req.query.account) } : {}),
    ...(req.query.vendorId ? { vendorId: String(req.query.vendorId) } : {}),
    ...(req.query.publisherId ? { publisherId: String(req.query.publisherId) } : {}),
  };
  const [rows, total, byType] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: {
        vendor: { select: { companyName: true } },
        publisher: { select: { displayName: true } },
      },
    }),
    prisma.ledgerEntry.count({ where }),
    prisma.ledgerEntry.groupBy({ by: ['type'], _sum: { amountMicros: true }, _count: { _all: true } }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows, byType });
}));

// ----------------------------------------------------------------- delivery

adminRouter.get('/impressions', requirePermission('delivery', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req, 50);
  const where = {
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.vendorId ? { vendorId: String(req.query.vendorId) } : {}),
    ...(req.query.publisherId ? { publisherId: String(req.query.publisherId) } : {}),
    ...(req.query.campaignId ? { campaignId: String(req.query.campaignId) } : {}),
    ...(req.query.country ? { country: String(req.query.country) } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.impression.findMany({
      where, take, skip, orderBy: { servedAt: 'desc' },
      include: {
        ad: { select: { headline: true } },
        campaign: { select: { name: true } },
        vendor: { select: { companyName: true } },
        publisher: { select: { displayName: true, user: { select: { email: true } } } },
        click: { select: { clickedAt: true } },
      },
    }),
    prisma.impression.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.get('/reports', requirePermission('dashboard', 'read'), wrap(async (req, res) => {
  const range = parseRange(req.query);
  const level = (String(req.query.level ?? 'city') as 'country' | 'state' | 'city' | 'area');
  const [agg, series, geo, hosts, campaigns] = await Promise.all([
    totals(range), timeSeries(range), geoBreakdown(range, {}, level), hostBreakdown(range), topCampaigns(range, {}, 50),
  ]);
  res.json({ totals: agg, series, geo, hosts, campaigns });
}));

// ----------------------------------------------------------------- platform

adminRouter.get('/settings', requirePermission('settings', 'read'), wrap(async (_req, res) => {
  res.json({ settings: await allSettings(), defaults: SETTING_DEFAULTS });
}));

adminRouter.put('/settings', requirePermission('settings', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.record(z.string()).parse(req.body);
  for (const [key, value] of Object.entries(body)) {
    if (!(key in SETTING_DEFAULTS)) throw ApiError.badRequest(`Unknown setting: ${key}`);
    await setSetting(key, value, req.user!.id);
  }
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'settings.updated', entity: 'SystemSetting', meta: body });
  res.json({ settings: await allSettings() });
}));

/** Gateway wiring status, so the console can say what is and is not connected. */
adminRouter.get('/integrations', requirePermission('settings', 'read'), wrap(async (_req, res) => {
  res.json({
    razorpay: { configured: razorpayEnabled, purpose: 'Vendor wallet top-ups' },
    razorpayX: { configured: razorpayXEnabled, purpose: 'Automated end-user payouts' },
  });
}));

/** Runs the auto-payout sweep immediately instead of waiting for the timer. */
adminRouter.post('/payouts/run-automation', requirePermission('payouts', 'update'), writeLimiter, wrap(async (req, res) => {
  const result = await runAutoPayouts();
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'payout.automation_run', entity: 'Payout', meta: result });
  res.json(result);
}));

// ─────────────────────────────────────────────────────── refunds & disputes

/** Returns unspent wallet balance to a vendor and journals it. */
adminRouter.post('/recharges/:id/refund', requirePermission('recharges', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    amountUsd: z.number().positive(),
    reason: z.string().min(3).max(300),
  }).parse(req.body);

  const recharge = await prisma.recharge.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
  if (!recharge) throw ApiError.notFound('Top-up not found');
  if (recharge.status !== 'COMPLETED') throw ApiError.badRequest('Only a settled top-up can be refunded');

  const amount = usdToMicros(body.amountUsd);
  const refundable = recharge.amountMicros - recharge.refundedMicros;
  if (amount > refundable) throw ApiError.badRequest(`At most ${Number(refundable) / 1e6} is still refundable on this top-up`);
  // Refunding money the vendor has already spent on delivery would leave the
  // wallet negative — the earners have been paid out of it.
  if (recharge.vendor.balanceMicros < amount) {
    throw ApiError.badRequest('That vendor has already spent this balance on delivery; it cannot be refunded');
  }

  const entry = await prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.update({
      where: { id: recharge.vendorId },
      data: { balanceMicros: { decrement: amount } },
    });
    await tx.recharge.update({ where: { id: recharge.id }, data: { refundedMicros: { increment: amount } } });
    return tx.ledgerEntry.create({
      data: {
        type: 'REFUND', account: 'VENDOR', amountMicros: -amount, vendorId: recharge.vendorId,
        balanceAfter: vendor.balanceMicros, note: `refund — ${body.reason}`, createdBy: req.user!.id,
      },
    });
  });

  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'recharge.refunded', entity: 'Recharge', entityId: recharge.id, meta: body });
  res.json({ entry, refundedMicros: amount.toString() });
}));

adminRouter.get('/disputes', requirePermission('recharges', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const [rows, total] = await Promise.all([
    prisma.dispute.findMany({
      where, take, skip, orderBy: { openedAt: 'desc' },
      include: { recharge: { include: { vendor: { select: { id: true, companyName: true, balanceMicros: true } } } } },
    }),
    prisma.dispute.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));

adminRouter.post('/disputes/:id/resolve', requirePermission('recharges', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    outcome: z.enum(['WON', 'LOST', 'ACCEPTED']),
    note: z.string().max(400).default(''),
    clawBack: z.boolean().default(false),
  }).parse(req.body);

  const dispute = await prisma.dispute.findUnique({ where: { id: req.params.id }, include: { recharge: true } });
  if (!dispute) throw ApiError.notFound('Dispute not found');
  if (dispute.resolvedAt) throw ApiError.conflict('Dispute already resolved');

  // Losing a chargeback means the money went back to the cardholder. Whether
  // the wallet is clawed back is a judgement call — the budget may be spent.
  if (body.clawBack && body.outcome !== 'WON') {
    await adjust({
      account: 'VENDOR', vendorId: dispute.recharge.vendorId,
      amountMicros: -dispute.amountMicros,
      note: `chargeback ${dispute.gatewayDisputeId ?? dispute.id}`,
      actorId: req.user!.id,
    });
  }

  const updated = await prisma.dispute.update({
    where: { id: dispute.id },
    data: { status: body.outcome, resolvedAt: new Date(), resolvedBy: req.user!.id, note: body.note },
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'dispute.resolved', entity: 'Dispute', entityId: dispute.id, meta: body });
  res.json(updated);
}));

// ─────────────────────────────────────────────────────── invoices & tax

adminRouter.get('/invoices', requirePermission('ledger', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const [rows, total, totals] = await Promise.all([
    prisma.invoice.findMany({
      where: req.query.vendorId ? { vendorId: String(req.query.vendorId) } : {},
      take, skip, orderBy: { issuedAt: 'desc' },
      include: { vendor: { select: { id: true, companyName: true } } },
    }),
    prisma.invoice.count(),
    prisma.invoice.aggregate({ _sum: { totalMicros: true, taxMicros: true } }),
  ]);
  res.json({
    page, total, pages: Math.ceil(total / take), data: rows,
    totals: { grossMicros: totals._sum.totalMicros ?? 0n, taxMicros: totals._sum.taxMicros ?? 0n },
    issuer: { name: env.billing.legalName, taxId: env.billing.taxId, taxLabel: env.billing.taxLabel, rateBps: env.billing.taxRateBps },
  });
}));

adminRouter.post('/publishers/:id/tax-document', requirePermission('endusers', 'update'), writeLimiter, wrap(async (req, res) => {
  const { year } = z.object({ year: z.number().int().min(2020).max(2100) }).parse(req.body);
  res.json(await buildTaxDocument(req.params.id, year));
}));

// ─────────────────────────────────────────────────────── trust & safety

adminRouter.get('/risk', requirePermission('delivery', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req, 50);
  const [events, total, byType, blockedDevices, flaggedImpressions] = await Promise.all([
    prisma.riskEvent.findMany({
      where: req.query.type ? { type: String(req.query.type) } : {},
      take, skip, orderBy: { createdAt: 'desc' },
      include: { publisher: { select: { id: true, displayName: true } } },
    }),
    prisma.riskEvent.count(),
    prisma.riskEvent.groupBy({ by: ['type'], _count: { _all: true }, _sum: { score: true } }),
    prisma.device.count({ where: { blockedAt: { not: null } } }),
    prisma.impression.count({ where: { flagged: true } }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: events, byType, blockedDevices, flaggedImpressions });
}));

adminRouter.post('/devices/:id/unblock', requirePermission('endusers', 'update'), writeLimiter, wrap(async (req, res) => {
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { blockedAt: null, riskScore: 0 },
  });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'device.unblocked', entity: 'Device', entityId: device.id });
  res.json(device);
}));

adminRouter.get('/blocklist', requirePermission('moderation', 'read'), wrap(async (_req, res) => {
  res.json(await prisma.urlBlocklist.findMany({ orderBy: { createdAt: 'desc' } }));
}));

adminRouter.post('/blocklist', requirePermission('moderation', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({ pattern: z.string().min(3).max(200), reason: z.string().min(3).max(200) }).parse(req.body);
  const row = await prisma.urlBlocklist.create({ data: { ...body, addedBy: req.user!.id } });
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: 'blocklist.added', entity: 'UrlBlocklist', entityId: row.id, meta: body });
  res.status(201).json(row);
}));

adminRouter.delete('/blocklist/:id', requirePermission('moderation', 'delete'), writeLimiter, wrap(async (req, res) => {
  await prisma.urlBlocklist.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

adminRouter.post('/creatives/rescan', requirePermission('moderation', 'update'), writeLimiter, wrap(async (_req, res) => {
  res.json(await rescanCreatives(100));
}));

// ─────────────────────────────────────────────────────── privacy queue

adminRouter.get('/privacy/requests', requirePermission('endusers', 'read'), wrap(async (req, res) => {
  const rows = await prisma.dataRequest.findMany({
    where: req.query.status ? { status: String(req.query.status) } : {},
    orderBy: { requestedAt: 'desc' },
    take: 100,
    include: { user: { select: { id: true, email: true, name: true, role: true } } },
  });
  res.json({ data: rows });
}));

adminRouter.post('/privacy/requests/:id/complete', requirePermission('endusers', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({ approve: z.boolean(), note: z.string().max(400).default('') }).parse(req.body);
  const request = await prisma.dataRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.status !== 'PENDING') throw ApiError.notFound('No pending request with that id');

  if (body.approve && request.type === 'ERASE') {
    try {
      await eraseUser(request.userId, req.user!.id);
    } catch (e) {
      throw ApiError.badRequest(e instanceof Error ? e.message : 'Could not erase this account');
    }
  }

  const updated = await prisma.dataRequest.update({
    where: { id: request.id },
    data: { status: body.approve ? 'COMPLETED' : 'REJECTED', completedAt: new Date(), handledBy: req.user!.id, note: body.note },
  });
  res.json(updated);
}));

// ─────────────────────────────────────────────────────── maintenance

adminRouter.post('/maintenance/:job', requirePermission('settings', 'update'), writeLimiter, wrap(async (req, res) => {
  const job = req.params.job;
  const jobs: Record<string, () => Promise<unknown>> = {
    'decay-risk': async () => ({ devicesDecayed: await decayRiskScores() }),
    'rescan-creatives': () => rescanCreatives(200),
    'run-payouts': () => runAutoPayouts(),
  };
  const run = jobs[job];
  if (!run) throw ApiError.badRequest(`Unknown job. Try: ${Object.keys(jobs).join(', ')}`);
  const result = await run();
  await audit({ actorId: req.user!.id, actorRole: 'SUPER_ADMIN', action: `maintenance.${job}`, entity: 'System', meta: result as object });
  res.json({ job, result });
}));

adminRouter.get('/audit', requirePermission('audit', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req, 50);
  const where = {
    ...(req.query.action ? { action: { contains: String(req.query.action), mode: 'insensitive' as const } } : {}),
    ...(req.query.entity ? { entity: String(req.query.entity) } : {}),
    ...(req.query.actorId ? { actorId: String(req.query.actorId) } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: { actor: { select: { email: true, name: true, role: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ page, total, pages: Math.ceil(total / take), data: rows });
}));
