/**
 * Process entry point: opens the port and owns the scheduled work.
 * The app itself lives in app.ts so tests can mount it without either.
 */
import { createApp } from './app.js';
import { env, googleEnabled, mailEnabled, razorpayEnabled, razorpayXEnabled, redisEnabled } from './env.js';
import { prisma } from './lib/prisma.js';
import { logger, captureError } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { withLock } from './services/locks.js';
import { purgeExpiredSessions } from './services/sessions.js';
import { purgeExpiredTokens } from './services/authTokens.js';
import { runAutoPayouts } from './services/payouts.js';
import { decayRiskScores } from './services/fraud.js';
import { rescanCreatives } from './services/urlSafety.js';
import { applyRetention } from './services/privacy.js';
import { IMPRESSION_TTL_MS } from './lib/constants.js';

const app = createApp();

// ─────────────────────────────────────────────────────────── background work

/**
 * Every instance runs these timers, so each job takes a short lease first.
 * Without that, N instances do the same work N times — harmless for a sweep,
 * expensive for anything that moves money.
 */
function schedule(name: string, everyMs: number, ttlSeconds: number, job: () => Promise<unknown>) {
  const timer = setInterval(() => {
    withLock(name, ttlSeconds, job).catch((err) => captureError(err, { job: name }));
  }, everyMs);
  timer.unref();
  return timer;
}

const timers = [
  // Served-but-never-confirmed impressions must not linger as pending revenue.
  schedule('sweep-impressions', 60_000, 55, async () => {
    const { count } = await prisma.impression.updateMany({
      where: { status: 'SERVED', servedAt: { lt: new Date(Date.now() - IMPRESSION_TTL_MS) } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }),

  schedule('purge-sessions', 30 * 60_000, 120, async () => {
    await purgeExpiredSessions();
    await purgeExpiredTokens();
  }),

  // No-ops unless a super admin switches auto-payout on.
  schedule('auto-payouts-tick', 5 * 60_000, 30, runAutoPayouts),

  // A destination can turn hostile after it was approved.
  schedule('rescan-creatives', 60 * 60_000, 600, () => rescanCreatives(100)),

  // Fraud scores decay so one bad afternoon is not a permanent ban.
  schedule('decay-risk', 60 * 60_000, 120, decayRiskScores),

  // Location detail ages out of old impressions.
  schedule('retention', 24 * 3600_000, 900, () => applyRetention()),
];

const server = app.listen(env.port, () => {
  const flag = (on: boolean) => (on ? 'on' : 'off');
  logger.info(
    {
      port: env.port,
      panel: env.corsOrigins,
      timezone: env.platformTimezone,
      integrations: { google: flag(googleEnabled), razorpay: flag(razorpayEnabled), razorpayX: flag(razorpayXEnabled), mail: flag(mailEnabled), redis: flag(redisEnabled) },
    },
    `AdPilot API listening on http://localhost:${env.port}`,
  );
  if (env.devAllowPasswordLogin) {
    logger.warn('DEV_ALLOW_PASSWORD_LOGIN is on — earner accounts can sign in with a password (development only)');
  }
  if (!redisEnabled) {
    logger.warn('REDIS_URL is unset — rate limits and delivery counters are per-process, so run a single instance only');
  }
});

process.on('unhandledRejection', (err) => captureError(err, { kind: 'unhandledRejection' }));
process.on('uncaughtException', (err) => { captureError(err, { kind: 'uncaughtException' }); process.exit(1); });

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal: sig }, 'shutting down');
    for (const t of timers) clearInterval(t);
    server.close(async () => {
      await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
