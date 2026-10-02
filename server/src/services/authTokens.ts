/** Single-use, hashed tokens for resets, verification and invites. */
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/crypto.js';
import { env } from '../env.js';

export type TokenPurpose = 'PASSWORD_RESET' | 'EMAIL_VERIFY' | 'TEAM_INVITE';

const TTL: Record<TokenPurpose, number> = {
  PASSWORD_RESET: 60 * 60_000,       // an hour
  EMAIL_VERIFY: 7 * 24 * 3600_000,   // a week
  TEAM_INVITE: 7 * 24 * 3600_000,
};

const PATH: Record<TokenPurpose, string> = {
  PASSWORD_RESET: '/reset-password',
  EMAIL_VERIFY: '/verify-email',
  TEAM_INVITE: '/accept-invite',
};

export async function issueToken(userId: string, purpose: TokenPurpose, meta: Record<string, unknown> = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  // Only one live token per purpose, so an old link cannot be used later.
  await prisma.authToken.deleteMany({ where: { userId, purpose, usedAt: null } });
  await prisma.authToken.create({
    data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TTL[purpose]), meta: JSON.stringify(meta) },
  });
  return { token, url: `${env.panelUrl}${PATH[purpose]}?token=${token}` };
}

export async function consumeToken(token: string, purpose: TokenPurpose) {
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt < new Date()) return null;
  await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return row;
}

/** Validates without spending it, so a reset page can render before submit. */
export async function peekToken(token: string, purpose: TokenPurpose) {
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: sha256(token) },
    select: { purpose: true, usedAt: true, expiresAt: true, user: { select: { email: true, name: true } } },
  });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt < new Date()) return null;
  return row;
}

export async function purgeExpiredTokens() {
  await prisma.authToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } }] },
  });
}
