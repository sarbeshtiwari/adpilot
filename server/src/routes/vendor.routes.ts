/**
 * Vendor (advertiser) API. Everything here is scoped to req.user.vendorId and
 * deliberately exposes only aggregates — a vendor can never reach an end user's
 * identity, device, email or raw impression rows.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, paging, wrap } from '../lib/http.js';
import { requireAuth, requirePermission, requireRole, requireVendor } from '../middleware/auth.js';
import { paymentLimiter, writeLimiter } from '../middleware/rateLimit.js';
import { createOrder, razorpayEnabled, usdMicrosToMinorUnits, verifyCheckoutSignature, fetchPayment, minorUnitsToUsdMicros } from '../services/razorpay.js';
import { env } from '../env.js';
import { usdToMicros } from '../lib/money.js';
import { AD_CATEGORIES, PRICING_MODELS } from '../lib/constants.js';
import { getBigInt, getBool } from '../services/settings.js';
import { creditVendor } from '../services/billing.js';
import { geoBreakdown, hostBreakdown, parseRange, timeSeries, topCampaigns, totals } from '../services/stats.js';
import { audit } from '../lib/audit.js';
import { checkAndRecord } from '../services/urlSafety.js';
import { invalidateCandidatePool } from '../services/adserve.js';

export const vendorRouter = Router();
vendorRouter.use(requireAuth, requireRole('VENDOR'), requireVendor);

const vid = (req: { user?: { vendorId?: string } }) => req.user!.vendorId!;

// ----------------------------------------------------------------- dashboard

vendorRouter.get('/overview', requirePermission('dashboard', 'read'), wrap(async (req, res) => {
  const range = parseRange(req.query);
  const vendorId = vid(req);

  const [vendor, agg, series, top, geo, hosts, campaignCounts] = await Promise.all([
    prisma.vendor.findUnique({ where: { id: vendorId } }),
    totals(range, { vendorId }),
    timeSeries(range, { vendorId }),
    topCampaigns(range, { vendorId }, 5),
    geoBreakdown(range, { vendorId }, 'city'),
    hostBreakdown(range, { vendorId }),
    prisma.campaign.groupBy({ by: ['status'], where: { vendorId }, _count: { _all: true } }),
  ]);

  res.json({
    vendor,
    totals: agg,
    series,
    topCampaigns: top,
    geo: geo.slice(0, 12),
    hosts,
    campaignCounts: Object.fromEntries(campaignCounts.map((c) => [c.status, c._count._all])),
    // Runway at the current burn rate, so the vendor knows when to top up.
    projectedDaysLeft: agg.spendMicros > 0n && vendor
      ? Number(vendor.balanceMicros) / (Number(agg.spendMicros) / Math.max(range.days, 1))
      : null,
  });
}));

// ----------------------------------------------------------------- campaigns

const geoRuleSchema = z.object({
  mode: z.enum(['INCLUDE', 'EXCLUDE']).default('INCLUDE'),
  country: z.string().min(1).default('*'),
  state: z.string().default('*'),
  city: z.string().default('*'),
  area: z.string().default('*'),
});

const campaignSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.enum(AD_CATEGORIES).default('general'),
  pricingModel: z.enum(PRICING_MODELS).default('CPM_CPC'),
  cpmUsd: z.number().min(0).default(0),
  cpcUsd: z.number().min(0).default(0),
  totalBudgetUsd: z.number().min(1),
  dailyBudgetUsd: z.number().min(0).default(0),
  startAt: z.string().datetime().or(z.string().min(4)),
  endAt: z.string().datetime().or(z.string().min(4)),
  dayparting: z.object({
    tz: z.string().default('UTC'),
    hours: z.array(z.number().int().min(0).max(23)).optional(),
    days: z.array(z.number().int().min(0).max(6)).optional(),
  }).nullable().optional(),
  frequencyCapPerDay: z.number().int().min(0).max(100).default(0),
  priority: z.number().int().min(1).max(10).default(5),
  geoRules: z.array(geoRuleSchema).default([]),
});

async function assertBids(pricingModel: string, cpm: bigint, cpc: bigint) {
  const [cpmFloor, cpcFloor] = await Promise.all([getBigInt('cpm_floor_micros'), getBigInt('cpc_floor_micros')]);
  if (pricingModel !== 'CPC' && cpm < cpmFloor) {
    throw ApiError.badRequest(`CPM bid is below the platform floor of $${Number(cpmFloor) / 1e6}`);
  }
  if (pricingModel !== 'CPM' && cpc < cpcFloor) {
    throw ApiError.badRequest(`CPC bid is below the platform floor of $${Number(cpcFloor) / 1e6}`);
  }
}

vendorRouter.get('/campaigns', requirePermission('campaigns', 'read'), wrap(async (req, res) => {
  const { take, skip, page } = paging(req);
  const where = {
    vendorId: vid(req),
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.q ? { name: { contains: String(req.query.q), mode: 'insensitive' as const } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.campaign.findMany({
      where, take, skip, orderBy: { createdAt: 'desc' },
      include: {
        geoRules: true,
        ads: { select: { id: true, status: true, impressionCount: true, clickCount: true } },
        _count: { select: { impressions: true } },
      },
    }),
    prisma.campaign.count({ where }),
  ]);

  res.json({
    page, total, pages: Math.ceil(total / take),
    data: rows.map((c) => {
      const impressions = c.ads.reduce((a, b) => a + b.impressionCount, 0);
      const clicks = c.ads.reduce((a, b) => a + b.clickCount, 0);
      return {
        ...c,
        stats: { impressions, clicks, ctr: impressions ? clicks / impressions : 0 },
        budgetUsedPct: c.totalBudgetMicros > 0n
          ? Number((c.spentMicros * 10000n) / c.totalBudgetMicros) / 100
          : 0,
      };
    }),
  });
}));

vendorRouter.post('/campaigns', requirePermission('campaigns', 'create'), writeLimiter, wrap(async (req, res) => {
  const body = campaignSchema.parse(req.body);
  const cpm = usdToMicros(body.cpmUsd);
  const cpc = usdToMicros(body.cpcUsd);
  await assertBids(body.pricingModel, cpm, cpc);

  const startAt = new Date(body.startAt);
  const endAt = new Date(body.endAt);
  if (endAt <= startAt) throw ApiError.badRequest('End date must be after the start date');

  const campaign = await prisma.campaign.create({
    data: {
      vendorId: vid(req),
      name: body.name,
      category: body.category,
      pricingModel: body.pricingModel,
      cpmMicros: cpm,
      cpcMicros: cpc,
      totalBudgetMicros: usdToMicros(body.totalBudgetUsd),
      dailyBudgetMicros: usdToMicros(body.dailyBudgetUsd),
      startAt, endAt,
      dayparting: body.dayparting ? JSON.stringify(body.dayparting) : null,
      frequencyCapPerDay: body.frequencyCapPerDay,
      priority: body.priority,
      status: 'DRAFT',
      geoRules: { create: body.geoRules },
    },
    include: { geoRules: true, ads: true },
  });

  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'campaign.created', entity: 'Campaign', entityId: campaign.id });
  res.status(201).json(campaign);
}));

vendorRouter.get('/campaigns/:id', requirePermission('campaigns', 'read'), wrap(async (req, res) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, vendorId: vid(req) },
    include: { geoRules: true, ads: { orderBy: { createdAt: 'asc' } } },
  });
  if (!campaign) throw ApiError.notFound('Campaign not found');

  const range = parseRange(req.query);
  const [series, geo] = await Promise.all([
    timeSeries(range, { campaignId: campaign.id }),
    geoBreakdown(range, { vendorId: vid(req) }, 'city'),
  ]);
  res.json({ campaign, series, geo: geo.slice(0, 20) });
}));

vendorRouter.patch('/campaigns/:id', requirePermission('campaigns', 'update'), writeLimiter, wrap(async (req, res) => {
  const existing = await prisma.campaign.findFirst({ where: { id: req.params.id, vendorId: vid(req) } });
  if (!existing) throw ApiError.notFound('Campaign not found');

  const body = campaignSchema.partial().parse(req.body);
  const cpm = body.cpmUsd !== undefined ? usdToMicros(body.cpmUsd) : existing.cpmMicros;
  const cpc = body.cpcUsd !== undefined ? usdToMicros(body.cpcUsd) : existing.cpcMicros;
  await assertBids(body.pricingModel ?? existing.pricingModel, cpm, cpc);

  const campaign = await prisma.campaign.update({
    where: { id: existing.id },
    data: {
      ...(body.name && { name: body.name }),
      ...(body.category && { category: body.category }),
      ...(body.pricingModel && { pricingModel: body.pricingModel }),
      cpmMicros: cpm,
      cpcMicros: cpc,
      ...(body.totalBudgetUsd !== undefined && { totalBudgetMicros: usdToMicros(body.totalBudgetUsd) }),
      ...(body.dailyBudgetUsd !== undefined && { dailyBudgetMicros: usdToMicros(body.dailyBudgetUsd) }),
      ...(body.startAt && { startAt: new Date(body.startAt) }),
      ...(body.endAt && { endAt: new Date(body.endAt) }),
      ...(body.dayparting !== undefined && { dayparting: body.dayparting ? JSON.stringify(body.dayparting) : null }),
      ...(body.frequencyCapPerDay !== undefined && { frequencyCapPerDay: body.frequencyCapPerDay }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.geoRules && { geoRules: { deleteMany: {}, create: body.geoRules } }),
    },
    include: { geoRules: true, ads: true },
  });

  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'campaign.updated', entity: 'Campaign', entityId: campaign.id });
  res.json(campaign);
}));

/** Vendors may submit, pause and resume. Only an admin can approve a submission. */
vendorRouter.post('/campaigns/:id/status', requirePermission('campaigns', 'update'), writeLimiter, wrap(async (req, res) => {
  const { action } = z.object({ action: z.enum(['submit', 'pause', 'resume', 'archive']) }).parse(req.body);
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, vendorId: vid(req) },
    include: { ads: true, vendor: true },
  });
  if (!campaign) throw ApiError.notFound('Campaign not found');

  let status = campaign.status;
  if (action === 'submit') {
    if (!campaign.ads.some((a) => a.status === 'ACTIVE')) {
      throw ApiError.badRequest('Add at least one active creative before submitting');
    }
    if (campaign.vendor.balanceMicros <= 0n) throw ApiError.payment('Top up your wallet before going live');
    status = (await getBool('auto_approve_campaigns')) ? 'ACTIVE' : 'PENDING_REVIEW';
  } else if (action === 'pause') {
    if (campaign.status !== 'ACTIVE') throw ApiError.badRequest('Only a live campaign can be paused');
    status = 'PAUSED';
  } else if (action === 'resume') {
    if (campaign.status !== 'PAUSED') throw ApiError.badRequest('Only a paused campaign can be resumed');
    if (campaign.vendor.balanceMicros <= 0n) throw ApiError.payment('Wallet is empty — top up to resume');
    status = 'ACTIVE';
  } else {
    status = 'COMPLETED';
  }

  const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: { status } });
  invalidateCandidatePool();
  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: `campaign.${action}`, entity: 'Campaign', entityId: campaign.id, meta: { status } });
  res.json(updated);
}));

vendorRouter.delete('/campaigns/:id', requirePermission('campaigns', 'delete'), writeLimiter, wrap(async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, vendorId: vid(req) } });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.status === 'ACTIVE') throw ApiError.badRequest('Pause the campaign before deleting it');
  await prisma.campaign.delete({ where: { id: campaign.id } });
  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'campaign.deleted', entity: 'Campaign', entityId: campaign.id });
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- creatives

const adSchema = z.object({
  headline: z.string().min(3).max(80),
  body: z.string().min(3).max(220),
  imageUrl: z.string().url().nullable().optional().or(z.literal('')),
  ctaText: z.string().min(2).max(24).default('Learn more'),
  clickUrl: z.string().url(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  weight: z.number().int().min(1).max(100).default(1),
});

vendorRouter.post('/campaigns/:id/ads', requirePermission('creatives', 'create'), writeLimiter, wrap(async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, vendorId: vid(req) } });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  const body = adSchema.parse(req.body);
  const ad = await prisma.ad.create({
    data: { ...body, imageUrl: body.imageUrl || null, campaignId: campaign.id },
  });

  const safety = await checkAndRecord(ad.id, body.clickUrl);
  if (safety.verdict === 'BLOCKED') {
    await prisma.ad.update({ where: { id: ad.id }, data: { status: 'REJECTED' } });
    throw ApiError.badRequest(`That destination cannot be advertised: ${safety.detail}`);
  }

  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'ad.created', entity: 'Ad', entityId: ad.id, meta: { urlVerdict: safety.verdict } });
  res.status(201).json({ ...ad, urlVerdict: safety.verdict, urlDetail: safety.detail });
}));

vendorRouter.patch('/ads/:id', requirePermission('creatives', 'update'), writeLimiter, wrap(async (req, res) => {
  const ad = await prisma.ad.findFirst({ where: { id: req.params.id, campaign: { vendorId: vid(req) } } });
  if (!ad) throw ApiError.notFound('Creative not found');
  const body = adSchema.partial().extend({ status: z.enum(['ACTIVE', 'PAUSED']).optional() }).parse(req.body);
  if (ad.status === 'REJECTED' && body.status) throw ApiError.badRequest('A rejected creative must be edited and resubmitted');
  const updated = await prisma.ad.update({
    where: { id: ad.id },
    data: { ...body, ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl || null }) },
  });

  // A changed destination is a new destination — re-check it.
  if (body.clickUrl && body.clickUrl !== ad.clickUrl) {
    const safety = await checkAndRecord(updated.id, body.clickUrl);
    if (safety.verdict === 'BLOCKED') {
      await prisma.ad.update({ where: { id: updated.id }, data: { status: 'REJECTED', clickUrl: ad.clickUrl } });
      throw ApiError.badRequest(`That destination cannot be advertised: ${safety.detail}`);
    }
  }
  invalidateCandidatePool();
  res.json(updated);
}));

vendorRouter.delete('/ads/:id', requirePermission('creatives', 'delete'), writeLimiter, wrap(async (req, res) => {
  const ad = await prisma.ad.findFirst({ where: { id: req.params.id, campaign: { vendorId: vid(req) } } });
  if (!ad) throw ApiError.notFound('Creative not found');
  await prisma.ad.delete({ where: { id: ad.id } });
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- wallet

vendorRouter.get('/wallet', requirePermission('wallet', 'read'), wrap(async (req, res) => {
  const vendorId = vid(req);
  const { take, skip, page } = paging(req);
  const [vendor, ledger, ledgerTotal, recharges] = await Promise.all([
    prisma.vendor.findUnique({ where: { id: vendorId } }),
    prisma.ledgerEntry.findMany({
      where: { vendorId, account: 'VENDOR' }, take, skip, orderBy: { createdAt: 'desc' },
    }),
    prisma.ledgerEntry.count({ where: { vendorId, account: 'VENDOR' } }),
    prisma.recharge.findMany({ where: { vendorId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  res.json({ vendor, ledger, ledgerPage: page, ledgerTotal, ledgerPages: Math.ceil(ledgerTotal / take), recharges });
}));

/**
 * Starts a top-up.
 *
 * With Razorpay configured this creates a gateway order and hands the browser
 * everything Checkout needs; the wallet is credited by the webhook once the
 * payment is actually captured — never on the client's say-so alone.
 * Without it, the request falls back to a manual transfer a super admin settles.
 */
vendorRouter.post('/wallet/recharge', requirePermission('wallet', 'create'), paymentLimiter, wrap(async (req, res) => {
  const body = z.object({
    amountUsd: z.number().min(10, 'Minimum top-up is $10').max(100_000),
    method: z.enum(['RAZORPAY', 'BANK', 'UPI', 'MANUAL']).default('RAZORPAY'),
    reference: z.string().max(80).default(''),
  }).parse(req.body);

  const amountMicros = usdToMicros(body.amountUsd);

  if (body.method === 'RAZORPAY') {
    if (!razorpayEnabled) {
      throw ApiError.badRequest('Card payments are not enabled on this server — choose a bank transfer instead');
    }
    const vendor = await prisma.vendor.findUnique({ where: { id: vid(req) }, select: { companyName: true, billingEmail: true, contactPhone: true } });
    const recharge = await prisma.recharge.create({
      data: { vendorId: vid(req), amountMicros, method: 'RAZORPAY', status: 'PENDING', gateway: 'razorpay' },
    });

    const order = await createOrder({
      amountMicros,
      receipt: `rch_${recharge.id.slice(0, 30)}`,
      notes: { rechargeId: recharge.id, vendorId: vid(req) },
    });
    await prisma.recharge.update({
      where: { id: recharge.id },
      data: { gatewayOrderId: order.id, gatewayAmount: order.amount, gatewayCurrency: order.currency },
    });

    await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'recharge.order_created', entity: 'Recharge', entityId: recharge.id, meta: { amountUsd: body.amountUsd, orderId: order.id } });

    return res.status(201).json({
      rechargeId: recharge.id,
      checkout: {
        key: env.razorpay.keyId,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        name: 'AdPilot',
        description: `Wallet top-up — $${body.amountUsd.toFixed(2)}`,
        prefill: { name: vendor?.companyName ?? '', email: vendor?.billingEmail ?? req.user!.email, contact: vendor?.contactPhone ?? '' },
      },
    });
  }

  const recharge = await prisma.recharge.create({
    data: { vendorId: vid(req), amountMicros, method: body.method, reference: body.reference, status: 'PENDING' },
  });
  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'recharge.requested', entity: 'Recharge', entityId: recharge.id, meta: { amountUsd: body.amountUsd, method: body.method } });
  res.status(201).json({ rechargeId: recharge.id, recharge, manual: true });
}));

/**
 * Checkout success callback. The webhook is the source of truth, but browsers
 * usually get here first — verifying the signature lets the panel confirm
 * instantly instead of spinning until the webhook lands.
 */
vendorRouter.post('/wallet/recharge/:id/verify', requirePermission('wallet', 'create'), paymentLimiter, wrap(async (req, res) => {
  const body = z.object({
    razorpayOrderId: z.string().min(4),
    razorpayPaymentId: z.string().min(4),
    razorpaySignature: z.string().min(10),
  }).parse(req.body);

  const recharge = await prisma.recharge.findFirst({ where: { id: req.params.id, vendorId: vid(req) } });
  if (!recharge) throw ApiError.notFound('Top-up not found');
  if (recharge.gatewayOrderId !== body.razorpayOrderId) throw ApiError.badRequest('That payment belongs to a different order');

  if (!verifyCheckoutSignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature)) {
    await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'recharge.bad_signature', entity: 'Recharge', entityId: recharge.id });
    throw ApiError.badRequest('Payment signature could not be verified');
  }

  // Already handled by the webhook — report the settled state, do not re-credit.
  if (recharge.status === 'COMPLETED') {
    return res.json({ status: 'COMPLETED', alreadySettled: true, creditedMicros: recharge.amountMicros.toString() });
  }

  // Confirm with the gateway rather than trusting the callback's word on capture.
  const payment = await fetchPayment(body.razorpayPaymentId);
  if (payment.status !== 'captured') {
    return res.json({ status: 'PENDING', gatewayStatus: payment.status, message: 'Payment is still being confirmed' });
  }

  const credited = minorUnitsToUsdMicros(payment.amount);
  await creditVendor(recharge.vendorId, credited, `Razorpay ${payment.id}`, req.user!.id);
  const updated = await prisma.recharge.update({
    where: { id: recharge.id },
    data: {
      status: 'COMPLETED', settledAt: new Date(), amountMicros: credited,
      gatewayPaymentId: payment.id, gatewayAmount: payment.amount, gatewayCurrency: payment.currency,
      reference: payment.id, note: 'verified at checkout',
    },
  });
  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'recharge.verified', entity: 'Recharge', entityId: recharge.id, meta: { paymentId: payment.id } });

  res.json({ status: 'COMPLETED', creditedMicros: updated.amountMicros.toString() });
}));

/** Polled by the panel while it waits for the webhook. */
vendorRouter.get('/wallet/recharge/:id', requirePermission('wallet', 'read'), wrap(async (req, res) => {
  const recharge = await prisma.recharge.findFirst({ where: { id: req.params.id, vendorId: vid(req) } });
  if (!recharge) throw ApiError.notFound('Top-up not found');
  res.json(recharge);
}));

/** Sandbox-only shortcut so the manual flow is demoable without a gateway. */
vendorRouter.post('/wallet/recharge/:id/simulate-settle', requirePermission('wallet', 'create'), wrap(async (req, res) => {
  if (env.isProd) throw ApiError.forbidden('Not available in production');
  const recharge = await prisma.recharge.findFirst({ where: { id: req.params.id, vendorId: vid(req) } });
  if (!recharge) throw ApiError.notFound('Top-up not found');
  if (recharge.status !== 'PENDING') throw ApiError.conflict('Top-up is not pending');
  if (recharge.gateway === 'razorpay') throw ApiError.badRequest('Card payments settle through the gateway, not this shortcut');

  await creditVendor(recharge.vendorId, recharge.amountMicros, `sandbox top-up ${recharge.method}`, req.user!.id);
  const updated = await prisma.recharge.update({
    where: { id: recharge.id },
    data: { status: 'COMPLETED', settledAt: new Date(), note: 'sandbox settlement' },
  });
  res.json(updated);
}));

// ----------------------------------------------------------------- profile

vendorRouter.get('/profile', requirePermission('settings', 'read'), wrap(async (req, res) => {
  const vendor = await prisma.vendor.findUnique({ where: { id: vid(req) } });
  res.json({ vendor, gateway: { razorpay: razorpayEnabled, currency: env.razorpay.currency, usdRate: env.razorpay.usdRate } });
}));

vendorRouter.patch('/profile', requirePermission('settings', 'update'), writeLimiter, wrap(async (req, res) => {
  const body = z.object({
    companyName: z.string().min(2).max(120).optional(),
    legalName: z.string().max(160).optional(),
    taxId: z.string().max(40).optional(),
    website: z.string().url().optional().or(z.literal('')),
    industry: z.string().max(60).optional(),
    contactPhone: z.string().max(30).optional(),
    billingEmail: z.string().email().optional().or(z.literal('')),
    addressLine1: z.string().max(160).optional(),
    addressLine2: z.string().max(160).optional(),
    city: z.string().max(80).optional(),
    state: z.string().max(80).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(2).optional(),
  }).parse(req.body);

  const vendor = await prisma.vendor.update({ where: { id: vid(req) }, data: body });
  await audit({ actorId: req.user!.id, actorRole: 'VENDOR', action: 'vendor.profile_updated', entity: 'Vendor', entityId: vendor.id, meta: body });
  res.json(vendor);
}));

// ----------------------------------------------------------------- invoices

vendorRouter.get('/invoices', requirePermission('wallet', 'read'), wrap(async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { vendorId: vid(req) },
    orderBy: { issuedAt: 'desc' },
    take: 200,
    include: { recharge: { select: { method: true, reference: true, settledAt: true } } },
  });
  res.json({
    invoices,
    issuer: { name: env.billing.legalName, taxId: env.billing.taxId, address: env.billing.address, taxLabel: env.billing.taxLabel },
  });
}));

vendorRouter.get('/invoices/:id', requirePermission('wallet', 'read'), wrap(async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, vendorId: vid(req) },
    include: { vendor: true, recharge: true },
  });
  if (!invoice) throw ApiError.notFound('Invoice not found');
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(invoice.meta); } catch { meta = {}; }
  res.json({ invoice: { ...invoice, meta } });
}));

// ----------------------------------------------------------------- reports

vendorRouter.get('/reports', requirePermission('reports', 'read'), wrap(async (req, res) => {
  const range = parseRange(req.query);
  const vendorId = vid(req);
  const level = (String(req.query.level ?? 'city') as 'country' | 'state' | 'city' | 'area');
  const [agg, series, geo, hosts, campaigns] = await Promise.all([
    totals(range, { vendorId }),
    timeSeries(range, { vendorId }),
    geoBreakdown(range, { vendorId }, level),
    hostBreakdown(range, { vendorId }),
    topCampaigns(range, { vendorId }, 25),
  ]);
  res.json({ totals: agg, series, geo, hosts, campaigns });
}));
