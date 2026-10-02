import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { can, parseGrants, type Action, type Scope } from '../lib/permissions.js';
import type { Role } from '../lib/constants.js';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  scope: Scope | null;
  vendorId?: string;
  publisherId?: string;
  isOwner: boolean;
  grants: Set<string>;
  totpEnabled: boolean;
  sessionId: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionToken?: string;
    }
  }
}

/** Throttles the lastSeenAt write so a busy dashboard is not a write storm. */
const SEEN_THROTTLE_MS = 60_000;

/**
 * Resolves the session cookie into a user, their panel scope and their
 * effective permission set. Every panel route goes through this.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw ApiError.unauthorized('Sign in to continue');

    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(String(token)) },
      include: {
        user: {
          include: {
            vendor: { select: { id: true, status: true } },
            publisher: { select: { id: true } },
            memberships: { where: { status: 'ACTIVE' } },
          },
        },
      },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Your session has expired — sign in again');
    }
    const user = session.user;
    if (user.status !== 'ACTIVE') throw ApiError.forbidden('This account is suspended');

    // A super admin without a confirmed second factor is not fully signed in.
    if (user.role === 'SUPER_ADMIN' && !user.totpEnabled) {
      throw new ApiError(403, 'Two-step verification must be set up before using the console', 'mfa_setup_required');
    }

    const membership =
      user.memberships.find((m) => (user.role === 'SUPER_ADMIN' ? m.scope === 'PLATFORM' : m.scope === 'VENDOR')) ?? null;

    if (Date.now() - session.lastSeenAt.getTime() > SEEN_THROTTLE_MS) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }

    req.sessionToken = String(token);
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
      scope: membership?.scope as Scope | null,
      vendorId: membership?.vendorId ?? user.vendor?.id,
      publisherId: user.publisher?.id,
      isOwner: membership?.role === 'OWNER',
      grants: new Set(membership ? parseGrants(membership.permissions) : []),
      totpEnabled: user.totpEnabled,
      sessionId: session.id,
    };
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole = (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden('Your role cannot access this area'));
    next();
  };

/** Vendor routes need a linked, non-suspended vendor. */
export async function requireVendor(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.vendorId) return next(ApiError.forbidden('No vendor account is linked to this login'));
  const v = await prisma.vendor.findUnique({ where: { id: req.user.vendorId }, select: { status: true } });
  if (!v) return next(ApiError.forbidden('Vendor account not found'));
  if (v.status === 'SUSPENDED') return next(ApiError.forbidden('This vendor account is suspended'));
  next();
}

export function requirePublisher(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.publisherId) return next(ApiError.forbidden('No earner profile is linked to this login'));
  next();
}

/**
 * Section-level guard. Read it as "this route needs campaigns:update".
 * Owners pass everything; members pass only what they were granted.
 */
export const requirePermission = (section: string, action: Action) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (can({ isOwner: req.user.isOwner, grants: req.user.grants }, section, action)) return next();
    next(new ApiError(403, `You do not have permission to ${action} ${section}`, 'permission_denied', { section, action }));
  };

/** Only the account owner may do this (transferring ownership, deleting the org). */
export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isOwner) return next(ApiError.forbidden('Only the account owner can do this'));
  next();
}
