import crypto from 'node:crypto';
import { env } from '../env.js';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** IPs are never stored raw — only a keyed hash, for fraud checks. */
export const hashIp = (ip: string) =>
  crypto.createHmac('sha256', env.impressionSecret).update(ip).digest('hex').slice(0, 32);

export const newDeviceKey = () => `apk_${crypto.randomBytes(24).toString('base64url')}`;

/**
 * Signed, single-purpose token handed to the extension with every served ad.
 * The client cannot mint impressions or fake the price without this.
 */
export function signImpression(impressionId: string, expiresAt: number): string {
  const payload = `${impressionId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', env.impressionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyImpression(token: string): { impressionId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [impressionId, expStr, sig] = parts;
  const expected = crypto
    .createHmac('sha256', env.impressionSecret)
    .update(`${impressionId}.${expStr}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expStr)) return null;
  return { impressionId };
}

/**
 * Short-lived, stateless proof that the password/Google step already passed.
 * Handed to the client between the first factor and the TOTP prompt so the
 * second step cannot be called cold.
 */
export function signChallenge(userId: string, purpose: string, ttlMs = 5 * 60_000): string {
  const exp = Date.now() + ttlMs;
  const payload = `${userId}.${purpose}.${exp}`;
  const sig = crypto.createHmac('sha256', env.impressionSecret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyChallenge(token: string, purpose: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString();
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', env.impressionSecret).update(payload).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [userId, tokenPurpose, expStr] = payload.split('.');
  if (tokenPurpose !== purpose) return null;
  if (Date.now() > Number(expStr)) return null;
  return { userId };
}
