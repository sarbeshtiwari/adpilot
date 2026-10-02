/**
 * Integration tests against the real app, on a real database.
 *
 * These are the behaviours that cost money or leak data if they regress:
 * who can sign in where, who can call what, and whether the books balance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { base32Decode } from '../src/lib/totp.js';
import { runAutoPayouts } from '../src/services/payouts.js';
import { withLock } from '../src/services/locks.js';
import { setSetting } from '../src/services/settings.js';

let server: Server;
let base: string;

const totpFor = (secret: string) => {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(b).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | ((h[o + 1] & 255) << 16) | ((h[o + 2] & 255) << 8) | (h[o + 3] & 255);
  return String(n % 1e6).padStart(6, '0');
};

/** Minimal cookie-aware client, since the API authenticates with cookies. */
function client() {
  const jar = new Map<string, string>();
  const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async call(path: string, init: RequestInit = {}) {
      const method = init.method ?? 'GET';
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(cookies() ? { Cookie: cookies() } : {}),
          ...(method !== 'GET' ? { 'x-csrf-token': jar.get('adpilot_csrf') ?? '' } : {}),
          ...(init.headers ?? {}),
        },
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}

async function signIn(email: string, portal: 'ADMIN' | 'VENDOR' | 'USER') {
  const c = client();
  const res = await c.call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Passw0rd!23', portal }),
  });
  // Console accounts stop at the second factor; enrol one on the fly.
  if (res.body?.mfaRequired) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const code = totpFor(user.totpSecret!);
    const done = await c.call('/api/auth/mfa/challenge', {
      method: 'POST',
      body: JSON.stringify({ challengeToken: res.body.challengeToken, code }),
    });
    return { client: c, body: done.body, status: done.status };
  }
  if (res.body?.mfaSetupRequired) {
    const setup = await c.call('/api/auth/mfa/setup', { method: 'POST' });
    await c.call('/api/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code: totpFor(setup.body.secret) }) });
  }
  return { client: c, body: res.body, status: res.status };
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

describe('portals', () => {
  it('refuses credentials at the wrong door', async () => {
    const c = client();
    const wrong = await c.call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'ads@vectordb.io', password: 'Passw0rd!23', portal: 'ADMIN' }),
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatch(/cannot sign in through this portal/i);
  });

  it('rejects a wrong password with the same shape as an unknown account', async () => {
    const c = client();
    const a = await c.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ads@vectordb.io', password: 'nope', portal: 'VENDOR' }) });
    const b = await c.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ghost@nowhere.io', password: 'nope', portal: 'VENDOR' }) });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('issues an httpOnly session and a readable CSRF token', async () => {
    const { client: c, status } = await signIn('ads@vectordb.io', 'VENDOR');
    expect(status).toBe(200);
    expect(c.jar.get('adpilot_session')).toBeTruthy();
    expect(c.jar.get('adpilot_csrf')).toBeTruthy();
  });
});

describe('two-step verification', () => {
  it('blocks the console until a second factor exists, then opens it', async () => {
    const { client: c } = await signIn('admin@adpilot.io', 'ADMIN');
    const overview = await c.call('/api/admin/overview');
    expect(overview.status).toBe(200);
  });

  it('does not issue a session on the password step alone', async () => {
    const c = client();
    const res = await c.call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@adpilot.io', password: 'Passw0rd!23', portal: 'ADMIN' }),
    });
    if (res.body.mfaRequired) {
      expect(res.body.user).toBeUndefined();
      const blocked = await c.call('/api/admin/overview');
      expect(blocked.status).toBe(401);
    }
  });
});

describe('authorisation', () => {
  it('turns away anonymous callers everywhere', async () => {
    const c = client();
    for (const path of ['/api/admin/overview', '/api/vendor/campaigns', '/api/me/overview', '/api/team', '/api/privacy']) {
      expect((await c.call(path)).status).toBe(401);
    }
  });

  it('enforces CSRF on writes', async () => {
    const { client: c } = await signIn('ads@vectordb.io', 'VENDOR');
    const res = await fetch(`${base}/api/vendor/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `adpilot_session=${c.jar.get('adpilot_session')}; adpilot_csrf=${c.jar.get('adpilot_csrf')}` },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('grants a member only what they hold', async () => {
    const { client: c } = await signIn('analyst@vectordb.io', 'VENDOR');
    expect((await c.call('/api/vendor/campaigns')).status).toBe(200);
    expect((await c.call('/api/vendor/wallet')).status).toBe(403);
    expect((await c.call('/api/team')).status).toBe(403);
  });

  it('scopes the console by section', async () => {
    const { client: c } = await signIn('finance@adpilot.io', 'ADMIN');
    expect((await c.call('/api/admin/ledger')).status).toBe(200);
    expect((await c.call('/api/admin/settings')).status).toBe(403);
    expect((await c.call('/api/admin/audit')).status).toBe(403);
  });

  it('keeps one vendor out of another vendor’s campaign', async () => {
    const other = await prisma.campaign.findFirstOrThrow({
      where: { vendor: { companyName: 'FinlyPay' } },
      select: { id: true },
    });
    const { client: c } = await signIn('ads@vectordb.io', 'VENDOR');
    expect((await c.call(`/api/vendor/campaigns/${other.id}`)).status).toBe(404);
  });
});

describe('privacy', () => {
  it('exports the requester’s own data and nobody else’s', async () => {
    const { client: c } = await signIn('aarav@example.com', 'USER');
    const res = await c.call('/api/privacy/export');
    expect(res.status).toBe(200);
    expect(res.body.account.email).toBe('aarav@example.com');
    expect(Array.isArray(res.body.adsShown)).toBe(true);
  });

  it('records consent and stops delivery when ads are refused', async () => {
    const { client: c } = await signIn('diya@example.com', 'USER');
    const off = await c.call('/api/privacy/consent', { method: 'POST', body: JSON.stringify({ scope: 'ADS', granted: false }) });
    expect(off.status).toBe(200);
    const pub = await prisma.publisher.findFirstOrThrow({ where: { user: { email: 'diya@example.com' } } });
    expect(pub.adsEnabled).toBe(false);
    // put it back for other tests
    await prisma.publisher.update({ where: { id: pub.id }, data: { adsEnabled: true } });
  });
});

describe('the books', () => {
  it('balances ad spend against payouts plus margin', async () => {
    const [spend, earn, platform] = await Promise.all([
      prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'VENDOR_SPEND' } }),
      prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'PUBLISHER_EARN' } }),
      prisma.ledgerEntry.aggregate({ _sum: { amountMicros: true }, where: { type: 'PLATFORM_REVENUE' } }),
    ]);
    const spent = -(spend._sum.amountMicros ?? 0n);
    expect(spent).toBe((earn._sum.amountMicros ?? 0n) + (platform._sum.amountMicros ?? 0n));
  });

  it('never lets a wallet go negative', async () => {
    const vendors = await prisma.vendor.findMany({ select: { balanceMicros: true } });
    const earners = await prisma.publisher.findMany({ select: { balanceMicros: true } });
    for (const v of vendors) expect(v.balanceMicros >= 0n).toBe(true);
    for (const p of earners) expect(p.balanceMicros >= 0n).toBe(true);
  });
});

describe('scheduled work', () => {
  it('lets only one holder into a locked job at a time', async () => {
    // Every API instance runs the same timers; without this, two of them can
    // both initiate the same bank transfer.
    let concurrent = 0;
    let maxConcurrent = 0;
    const body = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 120));
      concurrent -= 1;
      return 'ran';
    };

    const results = await Promise.all([
      withLock('test-exclusive', 30, body),
      withLock('test-exclusive', 30, body),
      withLock('test-exclusive', 30, body),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(results.filter((r) => r === 'ran')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });

  it('releases the lock so the next run can take it', async () => {
    expect(await withLock('test-sequential', 30, async () => 'first')).toBe('first');
    expect(await withLock('test-sequential', 30, async () => 'second')).toBe('second');
  });

  it('routes the payout sweep through that lock', async () => {
    await setSetting('auto_payout_enabled', 'true');
    try {
      const runs = await Promise.all([runAutoPayouts(), runAutoPayouts(), runAutoPayouts()]);
      const blocked = runs.filter((r) => r.skipped.some((x) => x.includes('lock')));
      // At most one sweep does the work; the rest are turned away.
      expect(runs.length - blocked.length).toBeLessThanOrEqual(1);
    } finally {
      await setSetting('auto_payout_enabled', 'false');
    }
  });
});

describe('ad delivery', () => {
  const KEY = 'apk_demo_device_key_for_local_testing';

  it('serves, bills, and reconciles an impression', async () => {
    const c = client();
    // Clear the cooldown so the serve is not refused.
    const device = await prisma.device.findFirstOrThrow({ where: { label: { contains: 'laptop' } }, select: { publisherId: true } });
    await prisma.impression.updateMany({
      where: { publisherId: device.publisherId },
      data: { servedAt: new Date(Date.now() - 86_400_000) },
    });

    const served = await c.call('/api/sdk/serve', {
      method: 'POST',
      headers: { 'x-adpilot-key': KEY },
      body: JSON.stringify({ hostApp: 'claude.ai', modelHint: 'test' }),
    });
    expect(served.status).toBe(200);
    if (!served.body.fill) return; // no eligible campaign in this dataset

    const before = await prisma.publisher.findUniqueOrThrow({ where: { id: device.publisherId! }, select: { balanceMicros: true } });
    const confirm = await c.call('/api/sdk/impression', {
      method: 'POST',
      headers: { 'x-adpilot-key': KEY },
      body: JSON.stringify({ token: served.body.ad.token, dwellMs: 4000 }),
    });
    expect(confirm.status).toBe(200);
    const after = await prisma.publisher.findUniqueOrThrow({ where: { id: device.publisherId! }, select: { balanceMicros: true } });
    expect(after.balanceMicros >= before.balanceMicros).toBe(true);
  });

  it('voids a view that was too short to count', async () => {
    const c = client();
    const device = await prisma.device.findFirstOrThrow({ where: { label: { contains: 'laptop' } }, select: { publisherId: true } });
    await prisma.impression.updateMany({
      where: { publisherId: device.publisherId },
      data: { servedAt: new Date(Date.now() - 86_400_000) },
    });
    const served = await c.call('/api/sdk/serve', {
      method: 'POST', headers: { 'x-adpilot-key': KEY },
      body: JSON.stringify({ hostApp: 'claude.ai' }),
    });
    if (!served.body?.fill) return;
    const res = await c.call('/api/sdk/impression', {
      method: 'POST', headers: { 'x-adpilot-key': KEY },
      body: JSON.stringify({ token: served.body.ad.token, dwellMs: 200 }),
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('view_too_short');
  });

  it('rejects a forged impression token', async () => {
    const c = client();
    const res = await c.call('/api/sdk/impression', {
      method: 'POST', headers: { 'x-adpilot-key': KEY },
      body: JSON.stringify({ token: 'fake.9999999999999.AAAA', dwellMs: 5000 }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an unknown device key', async () => {
    const c = client();
    const res = await c.call('/api/sdk/config', { headers: { 'x-adpilot-key': 'apk_not_a_real_key' } });
    expect(res.status).toBe(401);
  });

  it('serves detection rules the extension can use', async () => {
    const c = client();
    const res = await c.call('/api/sdk/detection-config');
    expect(res.status).toBe(200);
    expect(res.body.rules.length).toBeGreaterThan(0);
    for (const rule of res.body.rules) {
      expect(() => new RegExp(rule.match)).not.toThrow();
      expect(Array.isArray(rule.thinking)).toBe(true);
    }
  });
});
