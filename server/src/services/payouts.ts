/**
 * Withdrawal processing.
 *
 * Manual by default: a super admin approves and releases each request. When
 * `auto_payout_enabled` is on, this sweeps eligible requests on a timer —
 * paying them through RazorpayX if configured, otherwise auto-approving them
 * and leaving the transfer itself to a human.
 */
import { prisma } from '../lib/prisma.js';
import { getBool, getBigInt } from './settings.js';
import { debitPublisherForPayout } from './billing.js';
import { sendPayout, razorpayXEnabled } from './razorpay.js';
import { audit } from '../lib/audit.js';
import { withLock } from './locks.js';

const SYSTEM_ACTOR = 'system:auto-payout';

export type AutoPayoutRun = { considered: number; approved: number; paid: number; failed: number; skipped: string[] };

/**
 * Entry point for the timer. Wrapped in a lock because every API instance runs
 * the same schedule: without it two workers can pick up the same withdrawal and
 * both initiate a transfer. The ledger would catch the second write — but the
 * money would already have left twice.
 */
export async function runAutoPayouts(): Promise<AutoPayoutRun> {
  const empty: AutoPayoutRun = { considered: 0, approved: 0, paid: 0, failed: 0, skipped: [] };
  if (!(await getBool('auto_payout_enabled'))) return empty;
  return (await withLock('auto-payouts', 300, sweepPayouts)) ?? { ...empty, skipped: ['another instance holds the payout lock'] };
}

async function sweepPayouts(): Promise<AutoPayoutRun> {
  const result: AutoPayoutRun = { considered: 0, approved: 0, paid: 0, failed: 0, skipped: [] };

  const [minMicros, maxMicros] = await Promise.all([
    getBigInt('auto_payout_min_micros'),
    getBigInt('auto_payout_max_micros'),
  ]);

  const pending = await prisma.payout.findMany({
    where: { status: { in: ['REQUESTED', 'APPROVED'] } },
    include: { publisher: { include: { user: { select: { email: true, status: true } } } } },
    orderBy: { requestedAt: 'asc' },
    take: 25,
  });

  for (const payout of pending) {
    result.considered += 1;

    // Guard rails: never auto-release to a suspended account, never beyond the
    // per-payout ceiling, never more than the wallet actually holds.
    if (payout.publisher.user.status !== 'ACTIVE') { result.skipped.push(`${payout.id}: account not active`); continue; }
    if (payout.amountMicros < minMicros) { result.skipped.push(`${payout.id}: below auto threshold`); continue; }
    if (maxMicros > 0n && payout.amountMicros > maxMicros) { result.skipped.push(`${payout.id}: above auto ceiling, needs a human`); continue; }
    if (payout.publisher.balanceMicros < payout.amountMicros) { result.skipped.push(`${payout.id}: balance no longer covers it`); continue; }

    if (payout.status === 'REQUESTED') {
      await prisma.payout.update({ where: { id: payout.id }, data: { status: 'APPROVED', processedBy: SYSTEM_ACTOR, auto: true } });
      result.approved += 1;
    }

    // No payout rail configured — approval is as far as automation can go.
    if (!razorpayXEnabled) continue;

    // Second guard, inside the lock: claim the row atomically so even a stale
    // lock holder cannot send the same transfer twice.
    const claim = await prisma.payout.updateMany({
      where: { id: payout.id, claimedAt: null },
      data: { claimedAt: new Date(), claimedBy: SYSTEM_ACTOR },
    });
    if (claim.count === 0) { result.skipped.push(`${payout.id}: already claimed`); continue; }

    let details: Record<string, string> = {};
    try { details = payout.details ? JSON.parse(payout.details) : {}; } catch { details = {}; }
    if (!details.upiId && !details.accountNumber) {
      result.skipped.push(`${payout.id}: payout details incomplete`);
      continue;
    }

    try {
      const sent = await sendPayout({
        amountMicros: payout.amountMicros,
        method: payout.method,
        details,
        referenceId: payout.id,
        name: payout.publisher.displayName,
        email: payout.publisher.user.email,
      });
      // Money has left the building — debit the wallet and journal it.
      await debitPublisherForPayout(payout.id, SYSTEM_ACTOR);
      await prisma.payout.update({
        where: { id: payout.id },
        data: { auto: true, gateway: 'razorpayx', gatewayPayoutId: sent.id, reference: sent.id, note: `auto payout (${sent.status})` },
      });
      await audit({ actorRole: 'SYSTEM', action: 'payout.auto_paid', entity: 'Payout', entityId: payout.id, meta: { gatewayPayoutId: sent.id } });
      result.paid += 1;
    } catch (err) {
      result.failed += 1;
      const reason = err instanceof Error ? err.message : 'payout failed';
      // Release the claim so a later run can retry.
      await prisma.payout.update({
        where: { id: payout.id },
        data: { failureReason: reason.slice(0, 250), claimedAt: null, claimedBy: null },
      });
      await audit({ actorRole: 'SYSTEM', action: 'payout.auto_failed', entity: 'Payout', entityId: payout.id, meta: { reason } });
    }
  }

  return result;
}
