/**
 * Trust & safety.
 *
 * Every billable event pays a real person real money, so the cheapest attack is
 * to manufacture events. This scores each serve and click against a handful of
 * signals, holds anything that looks manufactured, and accumulates a rolling
 * score on the device so a persistent abuser stops being served at all.
 *
 * Signals are deliberately conservative: a false positive costs an honest
 * earner money, so thresholds hold rather than delete, and a human can review.
 */
import { prisma } from '../lib/prisma.js';
import { cache } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { getNumber } from './settings.js';
import { MIN_VIEW_MS } from '../lib/constants.js';

export type RiskSignal = { type: string; score: number; detail: string };
export type RiskResult = { score: number; flagged: boolean; signals: RiskSignal[] };

/** A human cannot read an ad and click it faster than this. */
const HUMAN_FLOOR_MS = 350;

async function thresholds() {
  const [flagAt, blockAt] = await Promise.all([
    getNumber('fraud_flag_score'),
    getNumber('fraud_block_score'),
  ]);
  return { flagAt, blockAt };
}

async function record(signals: RiskSignal[], ctx: { publisherId?: string; deviceId?: string; impressionId?: string }) {
  if (signals.length === 0) return;
  await prisma.riskEvent.createMany({
    data: signals.map((s) => ({
      publisherId: ctx.publisherId ?? null,
      deviceId: ctx.deviceId ?? null,
      impressionId: ctx.impressionId ?? null,
      type: s.type,
      score: s.score,
      detail: s.detail.slice(0, 250),
    })),
  });
}

/**
 * Raises the device's rolling score and stops serving it once it crosses the
 * block threshold. Decays over time so one bad afternoon is not permanent.
 */
async function bumpDevice(deviceId: string, delta: number) {
  if (delta <= 0) return;
  const { blockAt } = await thresholds();
  const device = await prisma.device.update({
    where: { id: deviceId },
    data: { riskScore: { increment: delta } },
    select: { id: true, riskScore: true, blockedAt: true, publisherId: true },
  });
  if (!device.blockedAt && device.riskScore >= blockAt) {
    await prisma.device.update({ where: { id: device.id }, data: { blockedAt: new Date() } });
    logger.warn({ deviceId: device.id, score: device.riskScore }, 'device blocked for suspected invalid traffic');
  }
}

// ─────────────────────────────────────────────────────────────── serve time

/**
 * Checked before an ad is booked. Cheap signals only — this is on the hot path.
 */
export async function scoreServe(ctx: { publisherId: string; deviceId: string; ipHash: string }): Promise<RiskResult> {
  const signals: RiskSignal[] = [];
  const { flagAt } = await thresholds();

  // One IP serving many distinct devices is the signature of a click farm or a
  // scripted fleet. Shared office NAT looks similar, so this scores rather
  // than blocks, and the count is generous.
  const ipDevicesKey = `risk:ipdev:${ctx.ipHash}`;
  const seen = await cache.getJson<string[]>(ipDevicesKey) ?? [];
  if (!seen.includes(ctx.deviceId)) {
    seen.push(ctx.deviceId);
    await cache.setJson(ipDevicesKey, seen.slice(-40), 6 * 3600);
  }
  if (seen.length > 12) {
    signals.push({ type: 'DUPLICATE_IP', score: Math.min((seen.length - 12) * 4, 40), detail: `${seen.length} devices share this IP` });
  }

  // Serve rate far above what the pacing rules should allow means something is
  // calling the endpoint directly rather than reacting to a model thinking.
  const burst = await cache.incr(`risk:burst:${ctx.deviceId}`, 60);
  if (burst > 10) {
    signals.push({ type: 'CLICK_VELOCITY', score: Math.min((burst - 10) * 6, 45), detail: `${burst} ad requests in 60s` });
  }

  const score = signals.reduce((a, s) => a + s.score, 0);
  const flagged = score >= flagAt;
  if (signals.length) await record(signals, { publisherId: ctx.publisherId, deviceId: ctx.deviceId });
  return { score, flagged, signals };
}

// ─────────────────────────────────────────────────────── impression & click

/** Run when the extension confirms a view, before anything is billed. */
export async function scoreImpression(imp: {
  id: string; publisherId: string | null; deviceId: string | null; riskScore: number;
}, dwellMs: number): Promise<RiskResult> {
  const signals: RiskSignal[] = [];
  const { flagAt } = await thresholds();

  if (dwellMs < MIN_VIEW_MS) {
    // Already voided by the caller; counted so a pattern of them is visible.
    const shorts = await cache.incr(`risk:short:${imp.deviceId ?? imp.publisherId}`, 3600);
    if (shorts > 5) {
      signals.push({ type: 'SHORT_DWELL', score: Math.min(shorts * 3, 30), detail: `${shorts} sub-threshold views this hour` });
    }
  }

  const score = imp.riskScore + signals.reduce((a, s) => a + s.score, 0);
  if (signals.length) {
    await record(signals, { publisherId: imp.publisherId ?? undefined, deviceId: imp.deviceId ?? undefined, impressionId: imp.id });
    if (imp.deviceId) await bumpDevice(imp.deviceId, signals.reduce((a, s) => a + s.score, 0));
  }
  return { score, flagged: score >= flagAt, signals };
}

/** Run when a click arrives. This is the event worth the most money to forge. */
export async function scoreClick(imp: {
  id: string; publisherId: string | null; deviceId: string | null; riskScore: number; servedAt: Date;
}, ctx: { ipHash: string; userAgent: string }): Promise<RiskResult> {
  const signals: RiskSignal[] = [];
  const { flagAt } = await thresholds();

  const sinceServe = Date.now() - imp.servedAt.getTime();
  if (sinceServe < HUMAN_FLOOR_MS) {
    signals.push({ type: 'IMPOSSIBLE_TIMING', score: 60, detail: `clicked ${sinceServe}ms after serve` });
  }

  // Click rate per device, over an hour.
  const clicks = await cache.incr(`risk:clicks:${imp.deviceId ?? imp.publisherId}`, 3600);
  if (clicks > 25) {
    signals.push({ type: 'CLICK_VELOCITY', score: Math.min((clicks - 25) * 5, 50), detail: `${clicks} clicks this hour` });
  }

  // The device key should stay on one browser; a changing UA suggests replay.
  if (imp.deviceId) {
    const uaKey = `risk:ua:${imp.deviceId}`;
    const known = await cache.get(uaKey);
    const fingerprint = ctx.userAgent.slice(0, 120);
    if (known && known !== fingerprint) {
      signals.push({ type: 'UA_MISMATCH', score: 25, detail: 'user agent changed for this device key' });
    }
    await cache.set(uaKey, fingerprint, 7 * 86_400);
  }

  const total = signals.reduce((a, s) => a + s.score, 0);
  const score = imp.riskScore + total;
  if (signals.length) {
    await record(signals, { publisherId: imp.publisherId ?? undefined, deviceId: imp.deviceId ?? undefined, impressionId: imp.id });
    if (imp.deviceId) await bumpDevice(imp.deviceId, total);
  }
  return { score, flagged: score >= flagAt, signals };
}

/** Rolling decay so a device can recover from a bad day. */
export async function decayRiskScores() {
  const decayed = await prisma.device.updateMany({
    where: { riskScore: { gt: 0 } },
    data: { riskScore: { decrement: 5 } },
  });
  await prisma.device.updateMany({ where: { riskScore: { lt: 0 } }, data: { riskScore: 0 } });
  // Unblock devices that have cooled off.
  const { blockAt } = await thresholds();
  await prisma.device.updateMany({
    where: { blockedAt: { not: null }, riskScore: { lt: Math.floor(blockAt / 2) } },
    data: { blockedAt: null },
  });
  return decayed.count;
}
