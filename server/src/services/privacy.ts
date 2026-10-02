/**
 * Data-subject rights.
 *
 * AdPilot records where someone was and which AI tool they were using, which
 * is exactly the kind of data people are entitled to see and to have removed.
 *
 * Erasure scrubs identity but keeps the financial record: the ledger has to
 * stay intact for tax and reconciliation, so impressions are detached from the
 * person rather than deleted.
 */
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

export async function recordConsent(input: {
  userId?: string; deviceId?: string; scope: 'ADS' | 'ANALYTICS' | 'LOCATION'; granted: boolean; ipHash?: string;
}) {
  return prisma.consentRecord.create({
    data: {
      userId: input.userId ?? null,
      deviceId: input.deviceId ?? null,
      scope: input.scope,
      granted: input.granted,
      policyVersion: env.privacyPolicyVersion,
      ipHash: input.ipHash ?? '',
    },
  });
}

/** Latest decision per scope. */
export async function currentConsent(userId: string) {
  const rows = await prisma.consentRecord.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  const latest = new Map<string, boolean>();
  for (const r of rows) if (!latest.has(r.scope)) latest.set(r.scope, r.granted);
  return {
    policyVersion: env.privacyPolicyVersion,
    scopes: Object.fromEntries(latest),
    upToDate: rows.some((r) => r.policyVersion === env.privacyPolicyVersion),
  };
}

/** Everything held about one person, in a portable shape. */
export async function exportUserData(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      publisher: { include: { devices: true, payouts: true, taxDocuments: true } },
      vendor: { include: { campaigns: { include: { ads: true, geoRules: true } }, recharges: true, invoices: true } },
      memberships: true,
      consents: true,
      sessions: { select: { userAgent: true, createdAt: true, lastSeenAt: true } },
    },
  });

  const impressions = user.publisher
    ? await prisma.impression.findMany({
        where: { publisherId: user.publisher.id },
        orderBy: { servedAt: 'desc' },
        take: 10_000,
        select: {
          servedAt: true, status: true, hostApp: true, modelHint: true,
          country: true, state: true, city: true, area: true,
          dwellMs: true, payoutMicros: true,
          ad: { select: { headline: true, campaign: { select: { vendor: { select: { companyName: true } } } } } },
        },
      })
    : [];

  const ledger = await prisma.ledgerEntry.findMany({
    where: { OR: [{ publisherId: user.publisher?.id ?? '—' }, { vendorId: user.vendor?.id ?? '—' }] },
    orderBy: { createdAt: 'desc' },
    take: 10_000,
  });

  return {
    exportedAt: new Date().toISOString(),
    policyVersion: env.privacyPolicyVersion,
    account: {
      id: user.id, email: user.email, name: user.name, role: user.role,
      createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
      emailVerified: user.emailVerified, twoStepEnabled: user.totpEnabled,
      signInMethods: [user.passwordHash ? 'password' : null, user.googleId ? 'google' : null].filter(Boolean),
    },
    earner: user.publisher && {
      displayName: user.publisher.displayName,
      balanceMicros: user.publisher.balanceMicros.toString(),
      lifetimeEarnedMicros: user.publisher.lifetimeEarnedMicros.toString(),
      lastKnownLocation: { country: user.publisher.country, state: user.publisher.state, city: user.publisher.city, area: user.publisher.area },
      adPreferences: { adsEnabled: user.publisher.adsEnabled, blockedCategories: user.publisher.blockedCategories },
      devices: user.publisher.devices.map((d) => ({ label: d.label, platform: d.platform, browser: d.browser, addedAt: d.createdAt, lastSeenAt: d.lastSeenAt })),
      payouts: user.publisher.payouts.map((p) => ({ amountMicros: p.amountMicros.toString(), method: p.method, status: p.status, requestedAt: p.requestedAt, processedAt: p.processedAt })),
      taxDocuments: user.publisher.taxDocuments,
    },
    advertiser: user.vendor && {
      companyName: user.vendor.companyName,
      balanceMicros: user.vendor.balanceMicros.toString(),
      campaigns: user.vendor.campaigns.length,
      invoices: user.vendor.invoices.map((i) => ({ number: i.number, totalMicros: i.totalMicros.toString(), issuedAt: i.issuedAt })),
    },
    adsShown: impressions.map((i) => ({
      at: i.servedAt, outcome: i.status, surface: i.hostApp, model: i.modelHint,
      location: [i.city, i.state, i.country].filter(Boolean).join(', '),
      visibleMs: i.dwellMs, earnedMicros: i.payoutMicros.toString(),
      advertiser: i.ad.campaign.vendor.companyName, headline: i.ad.headline,
    })),
    ledger: ledger.map((l) => ({ at: l.createdAt, type: l.type, amountMicros: l.amountMicros.toString(), note: l.note })),
    consentHistory: user.consents,
    sessions: user.sessions,
  };
}

/**
 * Erasure. Identity is scrubbed and access is revoked; money rows survive in
 * anonymised form because they are a legal record, not personal data we are
 * free to drop.
 */
export async function eraseUser(userId: string, handledBy: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { publisher: true, vendor: true },
  });

  if (user.vendor && user.vendor.balanceMicros > 0n) {
    throw new Error('This advertiser still holds a wallet balance — refund it before erasing the account.');
  }
  if (user.publisher && user.publisher.balanceMicros > 0n) {
    throw new Error('This earner still has unpaid earnings — settle them before erasing the account.');
  }

  const tombstone = `deleted-${user.id.slice(0, 8)}@removed.invalid`;

  await prisma.$transaction(async (tx) => {
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.authToken.deleteMany({ where: { userId } });
    await tx.recoveryCode.deleteMany({ where: { userId } });

    if (user.publisher) {
      // Detach delivery history from the person; the events themselves remain
      // for the advertiser's billing record.
      await tx.impression.updateMany({
        where: { publisherId: user.publisher.id },
        data: { publisherId: null, deviceId: null, ipHash: '', area: '', city: '' },
      });
      await tx.device.deleteMany({ where: { publisherId: user.publisher.id } });
      await tx.publisher.update({
        where: { id: user.publisher.id },
        data: {
          displayName: 'Removed account', payoutMethod: null, payoutDetails: null,
          country: null, state: null, city: null, area: null, taxId: null, taxCountry: null,
        },
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        email: tombstone, name: 'Removed account', passwordHash: null, googleId: null,
        avatarUrl: null, totpSecret: null, totpEnabled: false, status: 'SUSPENDED',
        anonymizedAt: new Date(),
      },
    });
  });

  await audit({ actorId: handledBy, actorRole: 'SUPER_ADMIN', action: 'privacy.user_erased', entity: 'User', entityId: userId });
  logger.info({ userId }, 'user erased on request');
}

/** Impression rows older than the retention window lose their location detail. */
export async function applyRetention(days = 400) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const { count } = await prisma.impression.updateMany({
    where: { servedAt: { lt: cutoff }, ipHash: { not: '' } },
    data: { ipHash: '', area: '', city: '' },
  });
  if (count) logger.info({ count, days }, 'retention: location detail scrubbed from old impressions');
  return count;
}
