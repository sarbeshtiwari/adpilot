import { prisma } from '../lib/prisma.js';
import { splitRevenue } from '../lib/money.js';
import { getNumber } from './settings.js';
import { platformDayKey } from '../lib/time.js';
import { invalidateCandidatePool } from './adserve.js';
import { ApiError } from '../lib/http.js';

/**
 * Spend booked against a campaign today, read from the counter the charge path
 * maintains. Kept as a function so reporting and the auction agree on the rule.
 */
export function spentTodayOf(campaign: { spentTodayMicros: bigint; spentTodayDate: string }): bigint {
  return campaign.spentTodayDate === platformDayKey() ? campaign.spentTodayMicros : 0n;
}

type ChargeKind = 'IMPRESSION' | 'CLICK';

/**
 * Moves money for one billable event, atomically:
 *   vendor wallet -> end-user wallet + platform revenue
 * and writes the matching journal rows. Returns the amounts booked.
 */
export async function bookEvent(opts: {
  kind: ChargeKind;
  impressionId: string;
  grossMicros: bigint;
}) {
  const shareBps = await getNumber('publisher_share_bps');

  return prisma.$transaction(async (tx) => {
    const imp = await tx.impression.findUnique({
      where: { id: opts.impressionId },
      include: { campaign: true, vendor: true },
    });
    if (!imp) throw ApiError.notFound('Impression not found');

    const gross = opts.grossMicros;
    // Never let a wallet go negative: bill at most what the vendor still holds
    // and at most what the campaign budget has left.
    const budgetLeft = imp.campaign.totalBudgetMicros - imp.campaign.spentMicros;
    const billable = [gross, imp.vendor.balanceMicros, budgetLeft].reduce((a, b) => (b < a ? b : a));
    if (billable <= 0n) return { costMicros: 0n, payoutMicros: 0n, platformMicros: 0n, starved: true };

    const { publisherMicros, platformMicros } = splitRevenue(billable, shareBps);

    const vendor = await tx.vendor.update({
      where: { id: imp.vendorId },
      data: {
        balanceMicros: { decrement: billable },
        lifetimeSpendMicros: { increment: billable },
      },
    });

    // Roll the daily counter over when the platform day changes, so pacing does
    // not have to aggregate impressions on every ad request.
    const today = platformDayKey();
    const carriedToday = imp.campaign.spentTodayDate === today ? imp.campaign.spentTodayMicros : 0n;
    const campaign = await tx.campaign.update({
      where: { id: imp.campaignId },
      data: {
        spentMicros: { increment: billable },
        spentTodayMicros: carriedToday + billable,
        spentTodayDate: today,
      },
    });

    if (imp.publisherId) {
      const pub = await tx.publisher.update({
        where: { id: imp.publisherId },
        data: {
          balanceMicros: { increment: publisherMicros },
          lifetimeEarnedMicros: { increment: publisherMicros },
        },
      });
      await tx.ledgerEntry.create({
        data: {
          type: 'PUBLISHER_EARN', account: 'PUBLISHER', amountMicros: publisherMicros,
          publisherId: imp.publisherId, impressionId: imp.id, balanceAfter: pub.balanceMicros,
          note: `${opts.kind.toLowerCase()} on campaign ${imp.campaign.name}`,
        },
      });
    }

    await tx.ledgerEntry.createMany({
      data: [
        {
          type: 'VENDOR_SPEND', account: 'VENDOR', amountMicros: -billable,
          vendorId: imp.vendorId, impressionId: imp.id, balanceAfter: vendor.balanceMicros,
          note: `${opts.kind.toLowerCase()} — ${imp.campaign.name}`,
        },
        {
          type: 'PLATFORM_REVENUE', account: 'PLATFORM', amountMicros: platformMicros,
          vendorId: imp.vendorId, impressionId: imp.id,
          note: `${opts.kind.toLowerCase()} margin`,
        },
      ],
    });

    // Budget exhausted, or wallet dry -> stop serving this campaign.
    if (campaign.spentMicros >= campaign.totalBudgetMicros && campaign.totalBudgetMicros > 0n) {
      await tx.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED' } });
      invalidateCandidatePool();
    }

    return { costMicros: billable, payoutMicros: publisherMicros, platformMicros, starved: billable < gross };
  });
}

/** Credit a vendor wallet (settled top-up) and journal it. */
export async function creditVendor(vendorId: string, amountMicros: bigint, note: string, actorId?: string) {
  return prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.update({
      where: { id: vendorId },
      data: {
        balanceMicros: { increment: amountMicros },
        lifetimeTopUpMicros: { increment: amountMicros },
      },
    });
    await tx.ledgerEntry.create({
      data: {
        type: 'VENDOR_TOPUP', account: 'VENDOR', amountMicros, vendorId,
        balanceAfter: vendor.balanceMicros, note, createdBy: actorId ?? null,
      },
    });
    return vendor;
  });
}

/** Debit an end-user wallet when a withdrawal is actually paid out. */
export async function debitPublisherForPayout(payoutId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findUnique({ where: { id: payoutId }, include: { publisher: true } });
    if (!payout) throw ApiError.notFound('Payout not found');
    if (payout.status === 'PAID') throw ApiError.conflict('Payout already settled');
    if (payout.publisher.balanceMicros < payout.amountMicros) {
      throw ApiError.badRequest('End-user balance no longer covers this payout');
    }

    const pub = await tx.publisher.update({
      where: { id: payout.publisherId },
      data: {
        balanceMicros: { decrement: payout.amountMicros },
        paidOutMicros: { increment: payout.amountMicros },
      },
    });
    await tx.ledgerEntry.create({
      data: {
        type: 'PUBLISHER_PAYOUT', account: 'PUBLISHER', amountMicros: -payout.amountMicros,
        publisherId: payout.publisherId, balanceAfter: pub.balanceMicros,
        note: `payout ${payout.method}`, createdBy: actorId,
      },
    });
    return tx.payout.update({
      where: { id: payoutId },
      data: { status: 'PAID', processedAt: new Date(), processedBy: actorId },
    });
  });
}

/** Manual correction by a super admin, on either side of the book. */
export async function adjust(opts: {
  account: 'VENDOR' | 'PUBLISHER';
  vendorId?: string;
  publisherId?: string;
  amountMicros: bigint;
  note: string;
  actorId: string;
}) {
  return prisma.$transaction(async (tx) => {
    let balanceAfter: bigint | null = null;
    if (opts.account === 'VENDOR' && opts.vendorId) {
      const v = await tx.vendor.update({
        where: { id: opts.vendorId },
        data: { balanceMicros: { increment: opts.amountMicros } },
      });
      balanceAfter = v.balanceMicros;
    } else if (opts.account === 'PUBLISHER' && opts.publisherId) {
      const p = await tx.publisher.update({
        where: { id: opts.publisherId },
        data: { balanceMicros: { increment: opts.amountMicros } },
      });
      balanceAfter = p.balanceMicros;
    } else {
      throw ApiError.badRequest('Adjustment needs a matching account id');
    }
    return tx.ledgerEntry.create({
      data: {
        type: 'ADJUSTMENT', account: opts.account, amountMicros: opts.amountMicros,
        vendorId: opts.vendorId ?? null, publisherId: opts.publisherId ?? null,
        balanceAfter, note: opts.note, createdBy: opts.actorId,
      },
    });
  });
}
