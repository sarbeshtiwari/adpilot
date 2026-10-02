/**
 * Extension-facing API. Authenticated with a per-device key, never a JWT, so a
 * stolen panel session cannot mint impressions and a stolen device key cannot
 * read the dashboard.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.js';
import { ApiError, wrap } from '../lib/http.js';
import { sha256, newDeviceKey, verifyImpression, hashIp } from '../lib/crypto.js';
import { clientIp, resolveGeo } from '../lib/geo.js';
import { selectAd } from '../services/adserve.js';
import { bookEvent } from '../services/billing.js';
import { MIN_VIEW_MS } from '../lib/constants.js';
import { getBool, getNumber, getSetting } from '../services/settings.js';
import { scoreClick, scoreImpression } from '../services/fraud.js';
import { audit } from '../lib/audit.js';

export const sdkRouter = Router();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: { id: string; publisherId: string };
    }
  }
}

async function requireDevice(req: Request, _res: Response, next: NextFunction) {
  try {
    const key = String(req.headers['x-adpilot-key'] ?? '');
    if (!key) throw ApiError.unauthorized('Missing device key');
    const device = await prisma.device.findUnique({
      where: { keyHash: sha256(key) },
      include: { publisher: { select: { id: true, user: { select: { status: true } } } } },
    });
    if (!device || device.revokedAt) throw ApiError.unauthorized('Device not paired or revoked');
    if (device.blockedAt) throw ApiError.forbidden('This device is suspended pending a delivery-quality review');
    if (device.publisher.user.status !== 'ACTIVE') throw ApiError.forbidden('Account inactive');
    req.device = { id: device.id, publisherId: device.publisherId };
    next();
  } catch (e) {
    next(e);
  }
}

const serveLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const pairLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// --------------------------------------------------------------- pairing

/** Claim a 8-char code generated in the end-user dashboard. */
sdkRouter.post('/pair', pairLimiter, wrap(async (req, res) => {
  const body = z.object({
    code: z.string().min(6).max(16),
    label: z.string().max(60).optional(),
    platform: z.string().max(40).optional(),
    browser: z.string().max(40).optional(),
    extVersion: z.string().max(20).optional(),
  }).parse(req.body);

  const code = body.code.trim().toUpperCase();
  const pending = await prisma.device.findUnique({
    where: { keyHash: sha256(`pairing:${code}`) },
    include: { publisher: { select: { id: true, displayName: true } } },
  });
  if (!pending || pending.revokedAt) throw ApiError.badRequest('Invalid or already used pairing code');
  if (pending.lastSeenAt) throw ApiError.badRequest('This pairing code has already been claimed');
  if (Date.now() - pending.createdAt.getTime() > 15 * 60_000) {
    throw ApiError.badRequest('Pairing code expired — generate a new one');
  }

  const key = newDeviceKey();
  const device = await prisma.device.update({
    where: { id: pending.id },
    data: {
      keyHash: sha256(key),
      label: body.label || pending.label.replace(/^Pending.*/, 'Paired device'),
      platform: body.platform ?? null,
      browser: body.browser ?? null,
      extVersion: body.extVersion ?? null,
      lastSeenAt: new Date(),
    },
  });

  await audit({ actorId: null, actorRole: 'DEVICE', action: 'device.paired', entity: 'Device', entityId: device.id });

  res.json({
    deviceKey: key,
    device: { id: device.id, label: device.label },
    publisher: { id: pending.publisher.id, displayName: pending.publisher.displayName },
  });
}));

// --------------------------------------------------------------- runtime

sdkRouter.get('/config', requireDevice, wrap(async (req, res) => {
  const [publisher, policyGap, policyCap] = await Promise.all([
    prisma.publisher.findUnique({
      where: { id: req.device!.publisherId },
      select: {
        displayName: true, adsEnabled: true, maxAdsPerHour: true,
        minSecondsBetweenAds: true, balanceMicros: true, lifetimeEarnedMicros: true,
      },
    }),
    getNumber('min_seconds_between_ads'),
    getNumber('max_ads_per_hour'),
  ]);
  await prisma.device.update({ where: { id: req.device!.id }, data: { lastSeenAt: new Date() } });

  // The extension gets the resolved policy, never the raw nullable override.
  res.json({
    publisher: publisher && {
      ...publisher,
      maxAdsPerHour: publisher.maxAdsPerHour ?? policyCap,
      minSecondsBetweenAds: publisher.minSecondsBetweenAds ?? policyGap,
    },
    serverTime: Date.now(),
  });
}));

/** Called the moment the extension detects the model has started thinking. */
sdkRouter.post('/serve', requireDevice, serveLimiter, wrap(async (req, res) => {
  const body = z.object({
    hostApp: z.string().max(80).default('unknown'),
    modelHint: z.string().max(80).default(''),
    excludeAdId: z.string().optional(),
  }).parse(req.body ?? {});

  const ip = clientIp(req.headers, req.socket.remoteAddress);
  const geo = await resolveGeo(ip);

  // Keep the user's last known location fresh for targeting.
  await prisma.publisher.update({
    where: { id: req.device!.publisherId },
    data: { country: geo.country, state: geo.state, city: geo.city, area: geo.area },
  });

  const result = await selectAd({
    publisherId: req.device!.publisherId,
    deviceId: req.device!.id,
    geo, ip,
    hostApp: body.hostApp,
    modelHint: body.modelHint,
    excludeAdId: body.excludeAdId,
  });

  if (!result.ok) return res.status(200).json({ fill: false, reason: result.reason, retryAfterSec: result.retryAfterSec ?? 30 });
  res.json({ fill: true, ad: result.ad });
}));

/** Confirms the ad was actually on screen; this is the billable moment. */
sdkRouter.post('/impression', requireDevice, wrap(async (req, res) => {
  const body = z.object({
    token: z.string(),
    dwellMs: z.number().int().min(0).max(600_000).default(0),
  }).parse(req.body);

  const verified = verifyImpression(body.token);
  if (!verified) throw ApiError.badRequest('Invalid or expired impression token');

  const imp = await prisma.impression.findUnique({
    where: { id: verified.impressionId },
    include: { campaign: true },
  });
  if (!imp) throw ApiError.notFound('Impression not found');
  if (imp.deviceId !== req.device!.id) throw ApiError.forbidden('Impression belongs to another device');
  if (imp.status !== 'SERVED') return res.json({ ok: true, alreadyCounted: true });

  if (body.dwellMs < MIN_VIEW_MS) {
    await prisma.impression.update({ where: { id: imp.id }, data: { status: 'VOID', dwellMs: body.dwellMs } });
    return res.json({ ok: false, reason: 'view_too_short' });
  }

  // Score before billing: a manufactured view should never reach a wallet.
  const risk = await scoreImpression(imp, body.dwellMs);
  const holdFlagged = await getBool('fraud_hold_flagged');
  if (risk.flagged && holdFlagged) {
    await prisma.impression.update({
      where: { id: imp.id },
      data: { status: 'VOID', dwellMs: body.dwellMs, riskScore: risk.score, flagged: true },
    });
    // Deliberately indistinguishable from a normal response — telling a
    // fraudster which signal tripped just teaches them to avoid it.
    return res.json({ ok: true, earnedMicros: '0' });
  }

  const billsCpm = imp.campaign.pricingModel !== 'CPC';
  const gross = billsCpm ? imp.campaign.cpmMicros / 1000n : 0n;

  let booked = { costMicros: 0n, payoutMicros: 0n, platformMicros: 0n };
  if (gross > 0n) booked = await bookEvent({ kind: 'IMPRESSION', impressionId: imp.id, grossMicros: gross });

  await prisma.$transaction([
    prisma.impression.update({
      where: { id: imp.id },
      data: {
        status: 'VIEWED', confirmedAt: new Date(), dwellMs: body.dwellMs, riskScore: risk.score,
        costMicros: booked.costMicros, payoutMicros: booked.payoutMicros, platformMicros: booked.platformMicros,
      },
    }),
    prisma.ad.update({ where: { id: imp.adId }, data: { impressionCount: { increment: 1 } } }),
  ]);

  res.json({ ok: true, earnedMicros: booked.payoutMicros.toString() });
}));

/** The user clicked the ad. Bills CPC and hands back the destination. */
sdkRouter.post('/click', requireDevice, wrap(async (req, res) => {
  const body = z.object({ token: z.string() }).parse(req.body);
  const verified = verifyImpression(body.token);
  if (!verified) throw ApiError.badRequest('Invalid or expired impression token');

  const imp = await prisma.impression.findUnique({
    where: { id: verified.impressionId },
    include: { campaign: true, ad: true, click: true },
  });
  if (!imp) throw ApiError.notFound('Impression not found');
  if (imp.deviceId !== req.device!.id) throw ApiError.forbidden('Impression belongs to another device');
  if (imp.click) return res.json({ ok: true, alreadyCounted: true, url: imp.ad.clickUrl });
  if (imp.status === 'VOID') throw ApiError.badRequest('This impression was voided');

  const ip = clientIp(req.headers, req.socket.remoteAddress);
  const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 250);

  const risk = await scoreClick(imp, { ipHash: hashIp(ip), userAgent });
  const holdFlagged = await getBool('fraud_hold_flagged');

  const billsCpc = imp.campaign.pricingModel !== 'CPM';
  const gross = billsCpc && !(risk.flagged && holdFlagged) ? imp.campaign.cpcMicros : 0n;

  let booked = { costMicros: 0n, payoutMicros: 0n, platformMicros: 0n };
  if (gross > 0n) booked = await bookEvent({ kind: 'CLICK', impressionId: imp.id, grossMicros: gross });
  await prisma.$transaction([
    prisma.click.create({
      data: {
        impressionId: imp.id,
        costMicros: booked.costMicros, payoutMicros: booked.payoutMicros, platformMicros: booked.platformMicros,
        ipHash: hashIp(ip), userAgent,
      },
    }),
    prisma.impression.update({
      where: { id: imp.id },
      data: { status: 'CLICKED', riskScore: risk.score, flagged: risk.flagged },
    }),
    prisma.ad.update({ where: { id: imp.adId }, data: { clickCount: { increment: 1 } } }),
  ]);

  res.json({ ok: true, url: imp.ad.clickUrl, earnedMicros: booked.payoutMicros.toString() });
}));

/**
 * Detection rules, served rather than shipped.
 *
 * The extension used to carry these selectors in its bundle, which meant a DOM
 * change at any AI vendor took every install offline until a new version was
 * published and users updated. Now it fetches them, caches them, and falls back
 * to its built-in copy if this is unreachable.
 */
sdkRouter.get('/detection-config', wrap(async (_req, res) => {
  const config = await getSetting('detection_config');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.json(JSON.parse(config));
}));

/** Lightweight liveness ping so the panel can show device status. */
sdkRouter.post('/heartbeat', requireDevice, wrap(async (req, res) => {
  const body = z.object({ extVersion: z.string().max(20).optional() }).parse(req.body ?? {});
  await prisma.device.update({
    where: { id: req.device!.id },
    data: { lastSeenAt: new Date(), ...(body.extVersion ? { extVersion: body.extVersion } : {}) },
  });
  res.json({ ok: true });
}));
