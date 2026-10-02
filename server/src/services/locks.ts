/**
 * Cooperative locks for scheduled work.
 *
 * Every API instance runs the same timers. Without this, two of them sweep
 * payouts at the same moment and can both initiate the same bank transfer —
 * the ledger would catch the second write, but the money has already gone.
 *
 * Backed by a unique primary key, so acquisition is atomic on any database.
 */
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const HOLDER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

export async function acquireLock(name: string, ttlSeconds: number): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  try {
    await prisma.jobLock.create({ data: { name, holder: HOLDER, expiresAt } });
    return true;
  } catch {
    // Someone holds it. Steal it only if their lease has expired — that covers
    // an instance that died mid-run.
    const stolen = await prisma.jobLock.updateMany({
      where: { name, expiresAt: { lt: now } },
      data: { holder: HOLDER, acquiredAt: now, expiresAt },
    });
    return stolen.count > 0;
  }
}

export async function releaseLock(name: string): Promise<void> {
  await prisma.jobLock.deleteMany({ where: { name, holder: HOLDER } });
}

/** Runs `fn` only if this instance wins the lock; otherwise returns null. */
export async function withLock<T>(name: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
  if (!(await acquireLock(name, ttlSeconds))) return null;
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, lock: name }, 'locked job failed');
    throw err;
  } finally {
    await releaseLock(name).catch(() => {});
  }
}
