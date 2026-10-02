import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { ApiError } from '../lib/http.js';
import { CSRF_COOKIE } from '../lib/cookies.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check. Cookies ride along on cross-site requests
 * automatically; a custom header does not, and an attacker cannot read the
 * cookie to forge one. Only cookie-authenticated routes need this — the
 * extension authenticates with an explicit device-key header instead.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();

  const cookie = req.cookies?.[CSRF_COOKIE];
  // No session cookie means this is not a cookie-authenticated call (login,
  // device pairing, webhooks); those carry their own protections.
  if (!cookie) return next();

  const header = req.get('x-csrf-token') ?? '';
  const a = Buffer.from(String(cookie));
  const b = Buffer.from(header);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new ApiError(403, 'CSRF token missing or invalid', 'csrf_failed'));
  }
  next();
}
