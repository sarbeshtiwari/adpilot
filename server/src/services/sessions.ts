import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { sha256, hashIp } from '../lib/crypto.js';
import { env } from '../env.js';

/** Opaque, high-entropy token. Only its SHA-256 ever reaches the database. */
export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(userId: string, req: { headers: Record<string, unknown>; ip?: string }) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + env.sessionTtlHours * 3600_000);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 250),
      ipHash: hashIp(req.ip ?? ''),
    },
  });
  return { token, expiresAt };
}

export async function revokeSession(token: string) {
  await prisma.session.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string, exceptToken?: string) {
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptToken ? { NOT: { tokenHash: sha256(exceptToken) } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

/** Expired and revoked rows are swept so the table stays small. */
export async function purgeExpiredSessions() {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] },
  });
}
