import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { SharedStore } from './rateLimitStore.js';
import { env } from '../env.js';

/**
 * Per-IP limits sized for a real deployment behind a proxy. Authenticated
 * requests key on the user id where available so one office IP does not
 * throttle a whole team.
 */
const keyByUserOrIp = (req: Request) => req.user?.id ?? req.ip ?? 'unknown';

const make = (name: string, opts: Partial<Options> & { windowMs: number; limit: number }) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down and try again shortly.', code: 'rate_limited' },
    // Shared across instances, so the limit is the limit however many run.
    store: new SharedStore(name),
    skip: () => env.rateLimitDisabled,
    ...opts,
  });

/** Blanket ceiling for the whole API. */
export const globalLimiter = make('global', { windowMs: 15 * 60_000, limit: 1500, keyGenerator: keyByUserOrIp });

/** Credential endpoints: tight, because these are what gets brute-forced. */
export const loginLimiter = make('login', { windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true });

/** Second-factor checks are even more sensitive than the password step. */
export const mfaLimiter = make('mfa', { windowMs: 15 * 60_000, limit: 8 });

/** Account creation and invites. */
export const signupLimiter = make('signup', { windowMs: 60 * 60_000, limit: 15 });

/** Anything that moves money. */
export const paymentLimiter = make('payment', { windowMs: 60_000, limit: 20, keyGenerator: keyByUserOrIp });

/** Extension ad requests. */
export const serveLimiter = make('serve', { windowMs: 60_000, limit: 60 });

/** Device pairing attempts, to stop code guessing. */
export const pairLimiter = make('pair', { windowMs: 60_000, limit: 10 });

/** General authenticated writes. */
export const writeLimiter = make('write', { windowMs: 60_000, limit: 120, keyGenerator: keyByUserOrIp });

/** Password-reset requests: strict, because they generate email to a third party. */
export const resetLimiter = make('reset', { windowMs: 60 * 60_000, limit: 5 });
