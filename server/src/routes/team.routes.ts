/**
 * Team management, one implementation for both panels.
 *
 *   scope PLATFORM → super-admin console users
 *   scope VENDOR   → one vendor's panel users
 *
 * The scope is derived from the signed-in user, never from the request body,
 * so a vendor cannot reach into the platform team by changing a field.
 */
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, wrap } from '../lib/http.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { signupLimiter, writeLimiter } from '../middleware/rateLimit.js';
import { allGrants, readOnlyGrants, sanitiseGrants, sectionsFor, parseGrants, type Scope } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { issueToken } from '../services/authTokens.js';
import { sendMail, templates } from '../services/mail.js';

export const teamRouter = Router();
teamRouter.use(requireAuth);

/** PLATFORM for a super admin, VENDOR for anyone in a vendor panel. */
function scopeOf(req: Request): { scope: Scope; vendorId: string | null } {
  if (req.user!.role === 'SUPER_ADMIN') return { scope: 'PLATFORM', vendorId: null };
  if (req.user!.role === 'VENDOR' && req.user!.vendorId) return { scope: 'VENDOR', vendorId: req.user!.vendorId };
  throw ApiError.forbidden('This account has no team to manage');
}

const memberWhere = (scope: Scope, vendorId: string | null) =>
  scope === 'PLATFORM' ? { scope: 'PLATFORM' as const } : { scope: 'VENDOR' as const, vendorId: vendorId! };

const shape = (m: {
  id: string; role: string; permissions: string; status: string; createdAt: Date;
  user: { id: string; email: string; name: string; status: string; lastLoginAt: Date | null; totpEnabled: boolean; googleId: string | null; passwordHash: string | null };
  invitedBy: { name: string; email: string } | null;
}, scope: Scope) => ({
  id: m.id,
  role: m.role,
  status: m.status,
  createdAt: m.createdAt,
  permissions: m.role === 'OWNER' ? allGrants(scope) : parseGrants(m.permissions),
  invitedBy: m.invitedBy,
  user: {
    id: m.user.id, email: m.user.email, name: m.user.name, status: m.user.status,
    lastLoginAt: m.user.lastLoginAt, totpEnabled: m.user.totpEnabled,
    signInMethods: [m.user.passwordHash ? 'password' : null, m.user.googleId ? 'google' : null].filter(Boolean),
  },
});

const include = {
  user: { select: { id: true, email: true, name: true, status: true, lastLoginAt: true, totpEnabled: true, googleId: true, passwordHash: true } },
  invitedBy: { select: { name: true, email: true } },
} as const;

// ───────────────────────────────────────────────────────────────── list

teamRouter.get('/', requirePermission('team', 'read'), wrap(async (req, res) => {
  const { scope, vendorId } = scopeOf(req);
  const members = await prisma.teamMember.findMany({
    where: memberWhere(scope, vendorId),
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include,
  });

  res.json({
    scope,
    members: members.map((m) => shape(m, scope)),
    // The catalogue the permission editor renders from.
    sections: sectionsFor(scope),
    presets: {
      full: allGrants(scope),
      readOnly: readOnlyGrants(scope),
    },
    you: { isOwner: req.user!.isOwner, userId: req.user!.id },
  });
}));

// ───────────────────────────────────────────────────────────────── create

teamRouter.post('/', requirePermission('team', 'create'), signupLimiter, wrap(async (req, res) => {
  const { scope, vendorId } = scopeOf(req);
  const body = z.object({
    name: z.string().min(2).max(80),
    email: z.string().email(),
    /** Omit to email them a set-password link instead of choosing one for them. */
    password: z.string().min(8).optional(),
    sendInvite: z.boolean().default(true),
    role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
    permissions: z.array(z.string()).default([]),
  }).parse(req.body);

  const email = body.email.toLowerCase();
  const grants = sanitiseGrants(scope, body.role === 'ADMIN' ? allGrants(scope) : body.permissions);
  if (grants.length === 0) throw ApiError.badRequest('Grant at least one permission');

  // A member can never hand out access they do not hold themselves.
  if (!req.user!.isOwner) {
    const mine = req.user!.grants;
    const excess = grants.filter((g) => !mine.has(g));
    if (excess.length) throw ApiError.forbidden(`You cannot grant permissions you do not have: ${excess.join(', ')}`);
  }

  const existing = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
  if (existing) {
    if (existing.role !== (scope === 'PLATFORM' ? 'SUPER_ADMIN' : 'VENDOR')) {
      throw ApiError.conflict('That email already belongs to a different kind of account');
    }
    if (existing.memberships.some((m) => m.scope === scope && m.vendorId === vendorId)) {
      throw ApiError.conflict('That person is already on this team');
    }
  }

  const userId = existing?.id ?? crypto.randomUUID();
  const created = await prisma.$transaction(async (tx) => {
    if (!existing) {
      await tx.user.create({
        data: {
          id: userId,
          email,
          name: body.name,
          role: scope === 'PLATFORM' ? 'SUPER_ADMIN' : 'VENDOR',
          passwordHash: body.password ? await bcrypt.hash(body.password, 10) : null,
        },
      });
    }
    return tx.teamMember.create({
      data: {
        userId,
        scope,
        vendorId,
        role: body.role,
        permissions: JSON.stringify(grants),
        status: 'ACTIVE',
        invitedById: req.user!.id,
      },
      include,
    });
  });

  await audit({
    actorId: req.user!.id, actorRole: req.user!.role, action: 'team.member_added',
    entity: 'TeamMember', entityId: created.id, meta: { email, scope, role: body.role, permissions: grants },
  });

  // Prefer emailing a link over an admin reading a password down the phone.
  let invited = false;
  if (body.sendInvite && !existing) {
    const organisation = scope === 'PLATFORM'
      ? 'the AdPilot console'
      : (await prisma.vendor.findUnique({ where: { id: vendorId! }, select: { companyName: true } }))?.companyName ?? 'your team';
    const { url } = await issueToken(userId, 'TEAM_INVITE', { organisation });
    invited = await sendMail(email, 'teamInvite', templates.teamInvite(body.name, req.user!.name, organisation, url), { scope });
  }

  res.status(201).json({
    member: shape(created, scope),
    invited,
    // Console members must enrol a second factor before the panel opens to them.
    mfaRequired: scope === 'PLATFORM',
  });
}));

// ───────────────────────────────────────────────────────────────── update

teamRouter.patch('/:id', requirePermission('team', 'update'), writeLimiter, wrap(async (req, res) => {
  const { scope, vendorId } = scopeOf(req);
  const body = z.object({
    role: z.enum(['ADMIN', 'MEMBER']).optional(),
    permissions: z.array(z.string()).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  }).parse(req.body);

  const member = await prisma.teamMember.findFirst({ where: { id: req.params.id, ...memberWhere(scope, vendorId) }, include });
  if (!member) throw ApiError.notFound('Team member not found');
  if (member.role === 'OWNER') throw ApiError.forbidden('The account owner cannot be edited here');
  if (member.userId === req.user!.id) throw ApiError.badRequest('You cannot change your own access');

  const nextRole = body.role ?? member.role;
  let grants = body.permissions
    ? sanitiseGrants(scope, body.permissions)
    : parseGrants(member.permissions);
  if (nextRole === 'ADMIN') grants = allGrants(scope);

  if (!req.user!.isOwner) {
    const excess = grants.filter((g) => !req.user!.grants.has(g));
    if (excess.length) throw ApiError.forbidden(`You cannot grant permissions you do not have: ${excess.join(', ')}`);
  }

  const updated = await prisma.teamMember.update({
    where: { id: member.id },
    data: { role: nextRole, permissions: JSON.stringify(grants), ...(body.status && { status: body.status }) },
    include,
  });

  // Suspending someone must cut their live sessions immediately.
  if (body.status === 'SUSPENDED') {
    await prisma.session.updateMany({ where: { userId: member.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  await audit({
    actorId: req.user!.id, actorRole: req.user!.role, action: 'team.member_updated',
    entity: 'TeamMember', entityId: member.id, meta: { role: nextRole, permissions: grants, status: body.status },
  });
  res.json({ member: shape(updated, scope) });
}));

// ───────────────────────────────────────────────────────────────── remove

teamRouter.delete('/:id', requirePermission('team', 'delete'), writeLimiter, wrap(async (req, res) => {
  const { scope, vendorId } = scopeOf(req);
  const member = await prisma.teamMember.findFirst({ where: { id: req.params.id, ...memberWhere(scope, vendorId) } });
  if (!member) throw ApiError.notFound('Team member not found');
  if (member.role === 'OWNER') throw ApiError.forbidden('The account owner cannot be removed');
  if (member.userId === req.user!.id) throw ApiError.badRequest('You cannot remove yourself');

  await prisma.$transaction([
    prisma.teamMember.delete({ where: { id: member.id } }),
    prisma.session.updateMany({ where: { userId: member.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  await audit({
    actorId: req.user!.id, actorRole: req.user!.role, action: 'team.member_removed',
    entity: 'TeamMember', entityId: member.id, meta: { userId: member.userId },
  });
  res.json({ ok: true });
}));
