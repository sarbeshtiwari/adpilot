import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../lib/cookies.js';

/**
 * Resolves the session WITHOUT the two-step-verification gate.
 *
 * A super admin who has not enrolled yet is in a chicken-and-egg state: they
 * are signed in but locked out of the console until TOTP exists. These routes
 * (enrolment, logout, /me) are the only ones reachable from there.
 */
export async function requireSessionOnly(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw ApiError.unauthorized('Sign in to continue');

    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(String(token)) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Your session has expired — sign in again');
    }
    if (session.user.status !== 'ACTIVE') throw ApiError.forbidden('This account is suspended');

    req.sessionToken = String(token);
    // Deliberately minimal: permission-bearing fields are only populated by the
    // full requireAuth, so nothing here can be mistaken for an authorised actor.
    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role as never,
      scope: null,
      isOwner: false,
      grants: new Set<string>(),
      totpEnabled: session.user.totpEnabled,
      sessionId: session.id,
    };
    next();
  } catch (e) {
    next(e);
  }
}
