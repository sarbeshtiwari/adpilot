/**
 * Data-subject rights, reachable by whoever the data is about.
 * The admin-side queue lives in admin.routes.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { currentConsent, exportUserData, recordConsent } from '../services/privacy.js';
import { hashIp } from '../lib/crypto.js';
import { clientIp } from '../lib/geo.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';

export const privacyRouter = Router();
privacyRouter.use(requireAuth);

privacyRouter.get('/', wrap(async (req, res) => {
  const [consent, requests] = await Promise.all([
    currentConsent(req.user!.id),
    prisma.dataRequest.findMany({ where: { userId: req.user!.id }, orderBy: { requestedAt: 'desc' } }),
  ]);
  res.json({ consent, requests, policyVersion: env.privacyPolicyVersion });
}));

privacyRouter.post('/consent', writeLimiter, wrap(async (req, res) => {
  const { scope, granted } = z.object({
    scope: z.enum(['ADS', 'ANALYTICS', 'LOCATION']),
    granted: z.boolean(),
  }).parse(req.body);

  await recordConsent({
    userId: req.user!.id, scope, granted,
    ipHash: hashIp(clientIp(req.headers, req.socket.remoteAddress)),
  });

  // Withdrawing ad consent has to actually stop delivery, not just be logged.
  if (scope === 'ADS' && !granted && req.user!.publisherId) {
    await prisma.publisher.update({ where: { id: req.user!.publisherId }, data: { adsEnabled: false } });
  }
  res.json({ ok: true, consent: await currentConsent(req.user!.id) });
}));

/** Immediate download — no waiting on a human for your own data. */
privacyRouter.get('/export', writeLimiter, wrap(async (req, res) => {
  const data = await exportUserData(req.user!.id);
  await prisma.dataRequest.create({
    data: { userId: req.user!.id, type: 'EXPORT', status: 'COMPLETED', completedAt: new Date() },
  });
  await audit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'privacy.data_exported', entity: 'User', entityId: req.user!.id });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="adpilot-data-${req.user!.id.slice(0, 8)}.json"`);
  res.send(JSON.stringify(data, null, 2));
}));

/**
 * Erasure is queued rather than immediate: money has to be settled first, and
 * that is a judgement call.
 */
privacyRouter.post('/erase', writeLimiter, wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(500).default('') }).parse(req.body ?? {});

  const open = await prisma.dataRequest.findFirst({
    where: { userId: req.user!.id, type: 'ERASE', status: 'PENDING' },
  });
  if (open) throw ApiError.conflict('You already have a deletion request in progress');

  const blockers: string[] = [];
  if (req.user!.publisherId) {
    const pub = await prisma.publisher.findUniqueOrThrow({ where: { id: req.user!.publisherId } });
    if (pub.balanceMicros > 0n) blockers.push('You have unpaid earnings — withdraw them first.');
  }
  if (req.user!.vendorId) {
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: req.user!.vendorId } });
    if (v.balanceMicros > 0n) blockers.push('Your wallet still holds a balance — request a refund first.');
  }

  const request = await prisma.dataRequest.create({
    data: { userId: req.user!.id, type: 'ERASE', note: reason },
  });
  await audit({ actorId: req.user!.id, actorRole: req.user!.role, action: 'privacy.erase_requested', entity: 'User', entityId: req.user!.id });

  res.status(201).json({ request, blockers });
}));

privacyRouter.delete('/erase/:id', wrap(async (req, res) => {
  const request = await prisma.dataRequest.findFirst({ where: { id: req.params.id, userId: req.user!.id, status: 'PENDING' } });
  if (!request) throw ApiError.notFound('No pending request to cancel');
  await prisma.dataRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', note: 'cancelled by user', completedAt: new Date() } });
  res.json({ ok: true });
}));
