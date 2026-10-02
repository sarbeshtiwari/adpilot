/**
 * Authentication.
 *
 * Three portals, three policies:
 *   USER   — Google only (a password escape hatch exists for local development)
 *   VENDOR — Google or password
 *   ADMIN  — Google or password, and TOTP is mandatory before the console opens
 *
 * The session lives in an httpOnly cookie; nothing sensitive is handed to page
 * scripts. Every response below returns the user shape the panel renders from.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';
import { ApiError, wrap } from '../lib/http.js';
import { env, googleEnabled } from '../env.js';
import { audit } from '../lib/audit.js';
import { clientIp } from '../lib/geo.js';
import { sha256, signChallenge, verifyChallenge } from '../lib/crypto.js';
import { setSessionCookies, clearSessionCookies } from '../lib/cookies.js';
import { createSession, revokeAllSessions, revokeSession } from '../services/sessions.js';
import { verifyGoogleIdToken } from '../services/googleAuth.js';
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { requireSessionOnly } from '../middleware/session.js';
import { loginLimiter, mfaLimiter, resetLimiter, signupLimiter } from '../middleware/rateLimit.js';
import { consumeToken, issueToken, peekToken } from '../services/authTokens.js';
import { sendMail, templates } from '../services/mail.js';
import { allGrants, readOnlyGrants, parseGrants } from '../lib/permissions.js';

export const authRouter = Router();

const PORTALS = { ADMIN: 'SUPER_ADMIN', VENDOR: 'VENDOR', USER: 'END_USER' } as const;
type Portal = keyof typeof PORTALS;

const portalSchema = z.enum(['ADMIN', 'VENDOR', 'USER']);

/** A login at one portal must never open a different panel. */
function assertPortal(role: string, portal: Portal) {
  if (PORTALS[portal] !== role) {
    throw ApiError.forbidden('This account cannot sign in through this portal');
  }
}

// ─────────────────────────────────────────────────────────── shared helpers

type FullUser = Awaited<ReturnType<typeof loadUser>>;

async function loadUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      vendor: true,
      publisher: true,
      memberships: { where: { status: 'ACTIVE' }, include: { vendor: { select: { id: true, companyName: true } } } },
    },
  });
  if (!user) throw ApiError.notFound('Account not found');
  return user;
}

function shapeUser(u: NonNullable<FullUser>) {
  const membership =
    u.memberships.find((m) => (u.role === 'SUPER_ADMIN' ? m.scope === 'PLATFORM' : m.scope === 'VENDOR')) ?? null;
  const grants = membership ? parseGrants(membership.permissions) : [];
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
    totpEnabled: u.totpEnabled,
    hasPassword: Boolean(u.passwordHash),
    googleLinked: Boolean(u.googleId),
    membership: membership && {
      scope: membership.scope,
      role: membership.role,
      isOwner: membership.role === 'OWNER',
      permissions: membership.role === 'OWNER' ? allGrants(membership.scope as 'PLATFORM' | 'VENDOR') : grants,
    },
    vendor: u.vendor && {
      id: u.vendor.id,
      companyName: u.vendor.companyName,
      status: u.vendor.status,
      balanceMicros: u.vendor.balanceMicros,
      onboardedAt: u.vendor.onboardedAt,
    },
    publisher: u.publisher && {
      id: u.publisher.id,
      displayName: u.publisher.displayName,
      balanceMicros: u.publisher.balanceMicros,
    },
  };
}

/**
 * Final step of every sign-in path. Issues the session cookie, or stops at the
 * TOTP challenge when the account has a second factor enrolled.
 */
async function completeLogin(req: Parameters<typeof clientIp>[0] extends never ? never : any, res: any, userId: string, method: string) {
  const user = await loadUser(userId);

  if (user.totpEnabled) {
    return res.json({
      mfaRequired: true,
      challengeToken: signChallenge(user.id, 'mfa'),
      method,
    });
  }

  const { token, expiresAt } = await createSession(user.id, { headers: req.headers, ip: clientIp(req.headers, req.socket.remoteAddress) });
  const csrfToken = setSessionCookies(res, token, expiresAt);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ actorId: user.id, actorRole: user.role, action: `auth.login.${method}`, entity: 'User', entityId: user.id, ip: clientIp(req.headers, req.socket.remoteAddress) });

  return res.json({
    user: shapeUser(user),
    csrfToken,
    // A super admin is signed in but cannot open the console until TOTP exists.
    mfaSetupRequired: user.role === 'SUPER_ADMIN' && !user.totpEnabled,
  });
}

// ─────────────────────────────────────────────────────────── config probe

/** Lets each login page render only the methods this deployment supports. */
authRouter.get('/config', (_req, res) => {
  res.json({
    google: { enabled: googleEnabled, clientId: env.googleClientId || null },
    passwordLoginForEndUsers: env.devAllowPasswordLogin,
    portals: {
      ADMIN: { password: true, google: googleEnabled, mfaRequired: true },
      VENDOR: { password: true, google: googleEnabled, mfaRequired: false, selfSignup: true },
      USER: { password: env.devAllowPasswordLogin, google: googleEnabled, mfaRequired: false, selfSignup: false },
    },
  });
});

// ─────────────────────────────────────────────────────────── password login

authRouter.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password, portal } = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    portal: portalSchema,
  }).parse(req.body);

  // End users are Google-only. The flag exists so the seeded demo accounts
  // still work locally; env.ts refuses to boot with it on in production.
  if (portal === 'USER' && !env.devAllowPasswordLogin) {
    throw ApiError.forbidden('Earner accounts sign in with Google');
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Same error and roughly the same work whether the account exists or not.
  if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw ApiError.unauthorized('Email or password is incorrect');
  }
  assertPortal(user.role, portal);
  if (user.status === 'SUSPENDED') throw ApiError.forbidden('This account has been suspended');

  return completeLogin(req, res, user.id, 'password');
}));

// ─────────────────────────────────────────────────────────── google login

authRouter.post('/google', loginLimiter, wrap(async (req, res) => {
  const { credential, portal } = z.object({
    credential: z.string().min(20),
    portal: portalSchema,
  }).parse(req.body);

  const profile = await verifyGoogleIdToken(credential);

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
  });

  if (!user) {
    // Only earners may create themselves. Vendors must submit business details
    // first; console users are created by an existing super admin.
    if (portal !== 'USER') {
      throw ApiError.forbidden(
        portal === 'VENDOR'
          ? 'No vendor account found for this Google address — complete onboarding first'
          : 'Console access is granted by an existing administrator',
      );
    }
    user = await prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name,
        role: 'END_USER',
        googleId: profile.googleId,
        avatarUrl: profile.picture,
        emailVerified: true,
        publisher: { create: { displayName: profile.name } },
      },
    });
    await audit({ actorId: user.id, actorRole: 'END_USER', action: 'auth.signup.google', entity: 'User', entityId: user.id });
  } else {
    assertPortal(user.role, portal);
    if (user.status === 'SUSPENDED') throw ApiError.forbidden('This account has been suspended');
    // First Google sign-in on a password account links the two.
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId: profile.googleId, emailVerified: true, avatarUrl: user.avatarUrl ?? profile.picture },
      });
    }
  }

  return completeLogin(req, res, user.id, 'google');
}));

// ─────────────────────────────────────────────────────────── second factor

authRouter.post('/mfa/challenge', mfaLimiter, wrap(async (req, res) => {
  const { challengeToken, code } = z.object({
    challengeToken: z.string().min(10),
    code: z.string().min(6).max(12),
  }).parse(req.body);

  const claim = verifyChallenge(challengeToken, 'mfa');
  if (!claim) throw ApiError.unauthorized('That verification step expired — sign in again');

  const user = await prisma.user.findUnique({ where: { id: claim.userId }, include: { recoveryCodes: true } });
  if (!user?.totpSecret) throw ApiError.unauthorized('Two-step verification is not set up for this account');

  const clean = code.trim().toUpperCase();
  let ok = verifyTotp(user.totpSecret, code);
  let usedRecovery = false;

  if (!ok) {
    // Recovery codes are single use; consume the first unused match.
    const match = user.recoveryCodes.find((r) => !r.usedAt && r.codeHash === sha256(clean));
    if (match) {
      await prisma.recoveryCode.update({ where: { id: match.id }, data: { usedAt: new Date() } });
      ok = true;
      usedRecovery = true;
    }
  }
  if (!ok) throw ApiError.unauthorized('That code is not valid');

  const ip = clientIp(req.headers, req.socket.remoteAddress);
  const { token, expiresAt } = await createSession(user.id, { headers: req.headers, ip });
  const csrfToken = setSessionCookies(res, token, expiresAt);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({
    actorId: user.id, actorRole: user.role,
    action: usedRecovery ? 'auth.mfa.recovery_used' : 'auth.mfa.verified',
    entity: 'User', entityId: user.id, ip,
  });

  const full = await loadUser(user.id);
  res.json({
    user: shapeUser(full),
    csrfToken,
    usedRecoveryCode: usedRecovery,
    remainingRecoveryCodes: user.recoveryCodes.filter((r) => !r.usedAt).length - (usedRecovery ? 1 : 0),
  });
}));

/** Step 1 of enrolment: mint a secret and render the QR the app will scan. */
authRouter.post('/mfa/setup', requireSessionOnly, wrap(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw ApiError.notFound('Account not found');
  if (user.totpEnabled) throw ApiError.conflict('Two-step verification is already switched on');

  const secret = generateSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });

  const uri = otpauthUri(secret, user.email);
  res.json({
    secret, // shown so it can be typed in if the camera is unavailable
    otpauthUri: uri,
    qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 240 }),
  });
}));

/** Step 2: prove the app works, switch it on, hand back the recovery codes. */
authRouter.post('/mfa/enable', requireSessionOnly, mfaLimiter, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(6) }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user?.totpSecret) throw ApiError.badRequest('Start the setup step first');
  if (user.totpEnabled) throw ApiError.conflict('Two-step verification is already switched on');
  if (!verifyTotp(user.totpSecret, code)) throw ApiError.badRequest('That code is not valid — check the time on your phone');

  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true, totpConfirmedAt: new Date() } }),
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId: user.id, codeHash: sha256(c) })) }),
  ]);
  await audit({ actorId: user.id, actorRole: user.role, action: 'auth.mfa.enabled', entity: 'User', entityId: user.id });

  res.json({ recoveryCodes: codes });
}));

authRouter.post('/mfa/disable', requireSessionOnly, mfaLimiter, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(6) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user?.totpEnabled || !user.totpSecret) throw ApiError.badRequest('Two-step verification is not switched on');
  // Non-negotiable for the console, whatever the user wants.
  if (user.role === 'SUPER_ADMIN') throw ApiError.forbidden('Two-step verification is mandatory for console accounts');
  if (!verifyTotp(user.totpSecret, code)) throw ApiError.badRequest('That code is not valid');

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, totpConfirmedAt: null } }),
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
  ]);
  await audit({ actorId: user.id, actorRole: user.role, action: 'auth.mfa.disabled', entity: 'User', entityId: user.id });
  res.json({ ok: true });
}));

authRouter.post('/mfa/recovery-codes', requireSessionOnly, mfaLimiter, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(6) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user?.totpEnabled || !user.totpSecret) throw ApiError.badRequest('Two-step verification is not switched on');
  if (!verifyTotp(user.totpSecret, code)) throw ApiError.badRequest('That code is not valid');

  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId: user.id, codeHash: sha256(c) })) }),
  ]);
  res.json({ recoveryCodes: codes });
}));

// ─────────────────────────────────────────────────────────── vendor signup

authRouter.post('/register/vendor', signupLimiter, wrap(async (req, res) => {
  const body = z.object({
    // account
    name: z.string().min(2).max(80),
    email: z.string().email(),
    password: z.string().min(8, 'Use at least 8 characters').optional(),
    googleCredential: z.string().optional(),
    // business
    companyName: z.string().min(2).max(120),
    legalName: z.string().max(160).optional(),
    taxId: z.string().max(40).optional(),
    website: z.string().url().optional().or(z.literal('')),
    industry: z.string().max(60).optional(),
    contactPhone: z.string().max(30).optional(),
    billingEmail: z.string().email().optional().or(z.literal('')),
    addressLine1: z.string().max(160).optional(),
    addressLine2: z.string().max(160).optional(),
    city: z.string().max(80).optional(),
    state: z.string().max(80).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(2).optional(),
  }).refine((b) => b.password || b.googleCredential, {
    message: 'Choose a password or continue with Google',
    path: ['password'],
  }).parse(req.body);

  let email = body.email.toLowerCase();
  let googleId: string | undefined;
  let avatarUrl: string | undefined;

  if (body.googleCredential) {
    const profile = await verifyGoogleIdToken(body.googleCredential);
    email = profile.email;
    googleId = profile.googleId;
    avatarUrl = profile.picture;
  }

  if (await prisma.user.findUnique({ where: { email } })) {
    throw ApiError.conflict('That email already has an account');
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: body.name,
      role: 'VENDOR',
      googleId,
      avatarUrl,
      emailVerified: Boolean(googleId),
      passwordHash: body.password ? await bcrypt.hash(body.password, 10) : null,
      vendor: {
        create: {
          companyName: body.companyName,
          legalName: body.legalName || null,
          taxId: body.taxId || null,
          website: body.website || null,
          industry: body.industry || null,
          contactPhone: body.contactPhone || null,
          billingEmail: body.billingEmail || null,
          addressLine1: body.addressLine1 || null,
          addressLine2: body.addressLine2 || null,
          city: body.city || null,
          state: body.state || null,
          postalCode: body.postalCode || null,
          country: body.country || null,
          status: 'PENDING',
          onboardedAt: new Date(),
        },
      },
    },
    include: { vendor: true },
  });

  // The signing-up user owns the vendor panel outright.
  await prisma.teamMember.create({
    data: { userId: user.id, scope: 'VENDOR', vendorId: user.vendor!.id, role: 'OWNER', permissions: JSON.stringify(allGrants('VENDOR')) },
  });
  await audit({ actorId: user.id, actorRole: 'VENDOR', action: 'vendor.onboarded', entity: 'Vendor', entityId: user.vendor!.id, meta: { companyName: body.companyName } });

  if (!googleId) {
    const { url } = await issueToken(user.id, 'EMAIL_VERIFY');
    await sendMail(user.email, 'emailVerify', templates.emailVerify(user.name, url), { userId: user.id });
  }

  return completeLogin(req, res, user.id, googleId ? 'google' : 'password');
}));

// ─────────────────────────────────────────────────────── password recovery

/**
 * Always answers the same way, whether or not the address exists — otherwise
 * this endpoint becomes a way to enumerate customers.
 */
authRouter.post('/forgot-password', resetLimiter, wrap(async (req, res) => {
  const { email, portal } = z.object({
    email: z.string().email(),
    portal: portalSchema.optional(),
  }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Google-only accounts have no password to reset; earners are Google-only by
  // policy. Both are silently skipped so the response stays uniform.
  const eligible =
    user &&
    user.status !== 'SUSPENDED' &&
    (user.passwordHash !== null || user.role !== 'END_USER') &&
    (!portal || PORTALS[portal] === user.role);

  if (eligible && user) {
    const { url } = await issueToken(user.id, 'PASSWORD_RESET');
    await sendMail(user.email, 'passwordReset', templates.passwordReset(user.name, url), { userId: user.id });
    await audit({ actorId: user.id, actorRole: user.role, action: 'auth.password_reset_requested', entity: 'User', entityId: user.id, ip: clientIp(req.headers, req.socket.remoteAddress) });
  }

  res.json({ ok: true, message: 'If that address has an account, a reset link is on its way.' });
}));

/** Lets the reset page show whose account it is before asking for a password. */
authRouter.get('/reset-password', wrap(async (req, res) => {
  const token = String(req.query.token ?? '');
  const row = token ? await peekToken(token, 'PASSWORD_RESET') : null;
  if (!row) throw ApiError.badRequest('That reset link has expired or already been used');
  res.json({ valid: true, email: row.user.email, name: row.user.name });
}));

authRouter.post('/reset-password', resetLimiter, wrap(async (req, res) => {
  const { token, newPassword } = z.object({
    token: z.string().min(10),
    newPassword: z.string().min(8, 'Use at least 8 characters'),
  }).parse(req.body);

  const row = await consumeToken(token, 'PASSWORD_RESET');
  if (!row) throw ApiError.badRequest('That reset link has expired or already been used');

  await prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
  // Whoever had the old password is signed out everywhere.
  await revokeAllSessions(row.userId);
  await audit({ actorId: row.userId, actorRole: row.user.role, action: 'auth.password_reset_completed', entity: 'User', entityId: row.userId });

  res.json({ ok: true, portal: row.user.role === 'SUPER_ADMIN' ? 'ADMIN' : row.user.role === 'VENDOR' ? 'VENDOR' : 'USER' });
}));

// ─────────────────────────────────────────────────────── invitations

/** Shows who invited you, before you set a password. */
authRouter.get('/accept-invite', wrap(async (req, res) => {
  const token = String(req.query.token ?? '');
  const row = token ? await peekToken(token, 'TEAM_INVITE') : null;
  if (!row) throw ApiError.badRequest('That invitation has expired or already been used');
  let meta: Record<string, string> = {};
  try { meta = JSON.parse((row as unknown as { meta?: string }).meta ?? '{}'); } catch { meta = {}; }
  res.json({ valid: true, email: row.user.email, name: row.user.name, organisation: meta.organisation ?? 'AdPilot' });
}));

authRouter.post('/accept-invite', signupLimiter, wrap(async (req, res) => {
  const { token, password } = z.object({
    token: z.string().min(10),
    password: z.string().min(8),
  }).parse(req.body);

  const row = await consumeToken(token, 'TEAM_INVITE');
  if (!row) throw ApiError.badRequest('That invitation has expired or already been used');

  await prisma.user.update({
    where: { id: row.userId },
    data: { passwordHash: await bcrypt.hash(password, 10), emailVerified: true },
  });
  await audit({ actorId: row.userId, actorRole: row.user.role, action: 'auth.invite_accepted', entity: 'User', entityId: row.userId });

  return completeLogin(req, res, row.userId, 'invite');
}));

// ─────────────────────────────────────────────────────── email verification

authRouter.post('/send-verification', requireSessionOnly, resetLimiter, wrap(async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
  const { url } = await issueToken(user.id, 'EMAIL_VERIFY');
  await sendMail(user.email, 'emailVerify', templates.emailVerify(user.name, url), { userId: user.id });
  res.json({ ok: true });
}));

authRouter.post('/verify-email', wrap(async (req, res) => {
  const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
  const row = await consumeToken(token, 'EMAIL_VERIFY');
  if (!row) throw ApiError.badRequest('That link has expired or already been used');
  await prisma.user.update({ where: { id: row.userId }, data: { emailVerified: true } });
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────── session admin

authRouter.get('/me', requireSessionOnly, wrap(async (req, res) => {
  const user = await loadUser(req.user!.id);
  res.json({
    user: shapeUser(user),
    mfaSetupRequired: user.role === 'SUPER_ADMIN' && !user.totpEnabled,
  });
}));

authRouter.post('/logout', requireSessionOnly, wrap(async (req, res) => {
  if (req.sessionToken) await revokeSession(req.sessionToken);
  clearSessionCookies(res);
  res.json({ ok: true });
}));

authRouter.get('/sessions', requireSessionOnly, wrap(async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })) });
}));

authRouter.delete('/sessions/:id', requireSessionOnly, wrap(async (req, res) => {
  await prisma.session.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { revokedAt: new Date() },
  });
  res.json({ ok: true });
}));

authRouter.post('/sessions/revoke-others', requireSessionOnly, wrap(async (req, res) => {
  await revokeAllSessions(req.user!.id, req.sessionToken);
  res.json({ ok: true });
}));

authRouter.post('/change-password', requireSessionOnly, loginLimiter, wrap(async (req, res) => {
  const { currentPassword, newPassword } = z.object({
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8),
  }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw ApiError.notFound('Account not found');

  // Google-only accounts are setting a password for the first time.
  if (user.passwordHash) {
    if (!currentPassword || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw ApiError.badRequest('Current password is incorrect');
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
  // A password change invalidates every other session.
  await revokeAllSessions(user.id, req.sessionToken);
  await audit({ actorId: user.id, actorRole: user.role, action: 'auth.password_changed', entity: 'User', entityId: user.id });
  res.json({ ok: true });
}));

export { readOnlyGrants };
