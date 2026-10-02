import type { Response } from 'express';
import crypto from 'node:crypto';
import { env } from '../env.js';

export const SESSION_COOKIE = 'adpilot_session';
export const CSRF_COOKIE = 'adpilot_csrf';

/**
 * The session cookie is httpOnly so page scripts — and anything injected into
 * them — cannot read it. The CSRF cookie deliberately is readable: the client
 * echoes it back in a header, and an attacker on another origin can do neither.
 */
function base(maxAgeMs: number) {
  return {
    domain: env.cookieDomain,
    path: '/',
    sameSite: 'lax' as const,
    secure: env.isProd,
    maxAge: maxAgeMs,
  };
}

export function setSessionCookies(res: Response, token: string, expiresAt: Date) {
  const maxAge = Math.max(expiresAt.getTime() - Date.now(), 0);
  const csrf = crypto.randomBytes(24).toString('base64url');
  res.cookie(SESSION_COOKIE, token, { ...base(maxAge), httpOnly: true });
  res.cookie(CSRF_COOKIE, csrf, { ...base(maxAge), httpOnly: false });
  return csrf;
}

export function clearSessionCookies(res: Response) {
  const opts = { domain: env.cookieDomain, path: '/' };
  res.clearCookie(SESSION_COOKIE, opts);
  res.clearCookie(CSRF_COOKIE, opts);
}
